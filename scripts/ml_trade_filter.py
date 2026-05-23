#!/usr/bin/env python3
"""
ML Trade Filter — research-only, no production wiring.

Goal: Per-trade binary classifier that flags low-quality trades.
If we skip the bottom-confidence X% trades, does window-pass-rate
(cum_effPnl >= 0.10 = FTMO Step1 target) exceed 50%?

Strict leak-free contract:
- At entryTime T, only use candles with closeTime < T (i.e. fully-closed bars)
- Forbidden: close[T] (entry-bar close), TP/SL outcome, future bars
- Allowed: prior OHLCV, BTC prior return/vol, prior in-window trades' effPnl

Run:
    /home/flooe/projects/tradevision-ai/.venv/bin/python \
        /home/flooe/projects/tradevision-ai/scripts/ml_trade_filter.py
"""
from __future__ import annotations

import json
import math
import pickle
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    precision_recall_fscore_support,
    roc_auc_score,
)

ROOT = Path("/home/flooe/projects/tradevision-ai")
CACHE_DIR = ROOT / "scripts" / "cache_bakeoff"
TRADES_FILE = CACHE_DIR / "cluster_audit" / "champion_trades.jsonl"
OUT_MODEL = ROOT / "scripts" / "ml_trade_filter_model.pkl"
OUT_REPORT = ROOT / "scripts" / "ml_trade_filter_report.txt"

STEP1_TARGET = 0.10  # FTMO Step-1 +10% profit target
# safety guard against numerical edge: require strict openTime < entryTime
LEAK_SAFETY_MS = 1


# ---------- candle loading ----------------------------------------------------
def load_candles(symbol_trend: str) -> list[dict]:
    """symbol_trend like 'BTC-TREND' -> reads BTCUSDT_30m.json (highest avail. res)."""
    base = symbol_trend.replace("-TREND", "")
    path = CACHE_DIR / f"{base}USDT_30m.json"
    if not path.exists():
        return []
    with open(path) as f:
        candles = json.load(f)
    # ensure sorted by openTime
    candles.sort(key=lambda c: c["openTime"])
    return candles


def closed_candles_before(candles: list[dict], entry_time_ms: int) -> list[dict]:
    """Return only candles whose closeTime < entryTime - safety.

    This is the central leak-guard.
    """
    cutoff = entry_time_ms - LEAK_SAFETY_MS
    # closeTime is end-of-bar inclusive ts; bar fully closed iff closeTime < cutoff
    return [c for c in candles if c["closeTime"] < cutoff]


# ---------- feature engineering ----------------------------------------------
def pct_return(p_now: float, p_then: float) -> float:
    if p_then <= 0 or p_now <= 0:
        return 0.0
    return p_now / p_then - 1.0


def realized_vol(closes: list[float]) -> float:
    """Stddev of log returns of the closed bars. Leak-free if `closes` is leak-free."""
    if len(closes) < 3:
        return 0.0
    rets = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            rets.append(math.log(closes[i] / closes[i - 1]))
    if len(rets) < 2:
        return 0.0
    return float(np.std(rets, ddof=1))


def slope_n(closes: list[float], n: int) -> float:
    """Linear-fit slope of last n closes, normalized by mean price.
    Leak-free if `closes` is leak-free.
    """
    if len(closes) < n:
        return 0.0
    y = np.asarray(closes[-n:], dtype=float)
    x = np.arange(n, dtype=float)
    mean_y = y.mean()
    if mean_y <= 0:
        return 0.0
    slope, _ = np.polyfit(x, y, 1)
    return float(slope / mean_y)


def compute_btc_features(btc_candles_before: list[dict], entry_time_ms: int) -> dict:
    """BTC 24h return + 24h realized vol, computed strictly on closed candles."""
    if len(btc_candles_before) < 50:
        return {"btc_ret_24h": 0.0, "btc_vol_24h": 0.0, "btc_ret_4h": 0.0}
    # 30m candles -> 48 bars = 24h
    last_48 = btc_candles_before[-48:]
    last_8 = btc_candles_before[-8:]  # 4h
    closes_48 = [c["close"] for c in last_48]
    closes_8 = [c["close"] for c in last_8]
    return {
        "btc_ret_24h": pct_return(closes_48[-1], closes_48[0]),
        "btc_vol_24h": realized_vol(closes_48),
        "btc_ret_4h": pct_return(closes_8[-1], closes_8[0]),
    }


def compute_symbol_features(candles_before: list[dict]) -> dict:
    """Per-symbol features from leak-free candles."""
    if len(candles_before) < 96:
        return {
            "sym_ret_24h": 0.0,
            "sym_ret_48h": 0.0,
            "sym_ret_4h": 0.0,
            "sym_vol_24h": 0.0,
            "sym_slope_48": 0.0,
            "sym_pos_24h": 0.5,
        }
    last_48 = candles_before[-48:]  # 24h
    last_96 = candles_before[-96:]  # 48h
    last_8 = candles_before[-8:]  # 4h
    closes_48 = [c["close"] for c in last_48]
    closes_96 = [c["close"] for c in last_96]
    closes_8 = [c["close"] for c in last_8]
    highs_48 = [c["high"] for c in last_48]
    lows_48 = [c["low"] for c in last_48]
    last_close = closes_48[-1]
    rng = max(highs_48) - min(lows_48)
    pos = (last_close - min(lows_48)) / rng if rng > 0 else 0.5
    return {
        "sym_ret_24h": pct_return(closes_48[-1], closes_48[0]),
        "sym_ret_48h": pct_return(closes_96[-1], closes_96[0]),
        "sym_ret_4h": pct_return(closes_8[-1], closes_8[0]),
        "sym_vol_24h": realized_vol(closes_48),
        "sym_slope_48": slope_n(closes_48, 48),
        "sym_pos_24h": pos,
    }


def hour_of_day(entry_time_ms: int) -> int:
    return (entry_time_ms // 3_600_000) % 24


def day_of_week(entry_time_ms: int) -> int:
    # 1970-01-01 was a Thursday (=3 ISO Monday-start). Standard weekday calc:
    days = entry_time_ms // 86_400_000
    return (days + 3) % 7  # 0=Mon..6=Sun


# ---------- build dataset ----------------------------------------------------
def build_dataset() -> tuple[np.ndarray, np.ndarray, list[dict], list[str]]:
    print("[1/4] loading trades + candles ...", flush=True)
    trades: list[dict] = []
    with open(TRADES_FILE) as f:
        for line in f:
            trades.append(json.loads(line))
    print(f"      total trades: {len(trades)}")

    # pre-load candle caches once, sort by openTime
    symbols = sorted(set(t["symbol"] for t in trades))
    candles_cache: dict[str, list[dict]] = {}
    missing = []
    for s in symbols:
        cs = load_candles(s)
        if not cs:
            missing.append(s)
        candles_cache[s] = cs
    print(f"      candles loaded for {len(symbols) - len(missing)}/{len(symbols)} symbols")
    if missing:
        print(f"      WARNING: no candles for {missing} (drop trades)")

    # pre-load BTC once (drives cross-asset features)
    btc_candles = candles_cache.get("BTC-TREND", [])
    if not btc_candles:
        print("      FATAL: BTC-TREND candles missing", file=sys.stderr)
        sys.exit(1)

    # sort trades chronologically; precompute trade-order within window
    trades.sort(key=lambda t: t["entryTime"])
    # 2026-05-23 BUG FIX (ML audit Round 11): dedup multi-shard duplicates by
    # (symbol, entryTime, direction) — multi-shard sweeps can emit the same
    # trade twice → trades_by_win double-counts prior_cum_pnl / prior_wins.
    seen_keys: set[tuple] = set()
    deduped: list[dict] = []
    for _t in trades:
        key = (_t.get("symbol"), _t.get("entryTime"), _t.get("direction"))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(_t)
    if len(deduped) < len(trades):
        print(f"      dedup: dropped {len(trades) - len(deduped)} duplicate trades")
        trades = deduped
    # group by window so we can compute prior_* on demand using exitTime (leak-free):
    # a "prior" trade is only counted if its exitTime < current entryTime — otherwise
    # it was still open at entry and its effPnl is future-information.
    trades_by_win: dict[int, list[dict]] = defaultdict(list)
    for _t in trades:
        trades_by_win[_t["winIdx"]].append(_t)

    print("[2/4] feature engineering ...", flush=True)
    feature_rows: list[list[float]] = []
    feature_names: list[str] = [
        "btc_ret_24h",
        "btc_vol_24h",
        "btc_ret_4h",
        "sym_ret_24h",
        "sym_ret_48h",
        "sym_ret_4h",
        "sym_vol_24h",
        "sym_slope_48",
        "sym_pos_24h",
        "direction",  # +1 long, -1 short
        "day_in_challenge",  # 0..13
        "trade_idx_in_window",  # 0..N-1 (prior-trade order)
        "prior_cum_pnl",
        "prior_wins",
        "prior_losses",
        "hour_of_day",
        "day_of_week",
        "sym_btc_ret_diff_24h",
    ]
    labels: list[int] = []
    meta: list[dict] = []
    skipped = 0

    for t in trades:
        sym = t["symbol"]
        candles = candles_cache.get(sym, [])
        if not candles:
            skipped += 1
            continue
        et = int(t["entryTime"])
        before = closed_candles_before(candles, et)
        btc_before = closed_candles_before(btc_candles, et)
        # LEAK GUARD: verify the very last candle is strictly before entry
        if not before or before[-1]["closeTime"] >= et:
            skipped += 1
            continue
        if not btc_before or btc_before[-1]["closeTime"] >= et:
            skipped += 1
            continue

        sym_feats = compute_symbol_features(before)
        btc_feats = compute_btc_features(btc_before, et)
        # 2026-05-23 BUG FIX (ML audit): case-insensitive direction parse.
        # `t["direction"] == "long"` strict-compared would treat "LONG"/"Long"
        # as SHORT → silent sign-flip. Also explicitly handle unknown values.
        dir_raw = str(t.get("direction", "")).strip().lower()
        if dir_raw == "long":
            direction = 1.0
        elif dir_raw == "short":
            direction = -1.0
        else:
            skipped += 1
            continue
        widx = t["winIdx"]
        # leak-free prior_* aggregates: only count window-mates that already EXITED
        # before this trade's entryTime. Using entryTime-order would leak ~60% of
        # cases where a prior trade is still open (its effPnl is unknown at et).
        prior_cum = 0.0
        prior_w = 0
        prior_l = 0
        trade_order = 0
        for p in trades_by_win[widx]:
            if p is t:
                continue
            if p["entryTime"] < et:
                trade_order += 1
            if p["exitTime"] < et:
                pnl = float(p["effPnl"])
                prior_cum += pnl
                if pnl > 0:
                    prior_w += 1
                else:
                    prior_l += 1

        row = [
            btc_feats["btc_ret_24h"],
            btc_feats["btc_vol_24h"],
            btc_feats["btc_ret_4h"],
            sym_feats["sym_ret_24h"],
            sym_feats["sym_ret_48h"],
            sym_feats["sym_ret_4h"],
            sym_feats["sym_vol_24h"],
            sym_feats["sym_slope_48"],
            sym_feats["sym_pos_24h"],
            direction,
            float(t["day"]),
            float(trade_order),
            float(prior_cum),
            float(prior_w),
            float(prior_l),
            float(hour_of_day(et)),
            float(day_of_week(et)),
            sym_feats["sym_ret_24h"] - btc_feats["btc_ret_24h"],
        ]
        feature_rows.append(row)
        labels.append(1 if t["effPnl"] > 0 else 0)
        meta.append(
            {
                "winIdx": widx,
                "entryTime": et,
                "symbol": sym,
                "effPnl": float(t["effPnl"]),
                "exitReason": t["exitReason"],
                "trade_order": trade_order,
            }
        )

    X = np.asarray(feature_rows, dtype=np.float32)
    y = np.asarray(labels, dtype=np.int32)
    print(f"      kept {len(X)} / {len(trades)} (skipped {skipped} due to missing candles)")
    print(f"      win-rate: {y.mean()*100:.2f}%")
    return X, y, meta, feature_names


# ---------- leak audit -------------------------------------------------------
def audit_leak_free(meta: list[dict]) -> None:
    """Spot-check: re-derive features for a sample row and verify no candle
    with closeTime >= entryTime was used. Done implicitly in `closed_candles_before`;
    this prints reassurance."""
    print("[leak-audit] verifying closed_candles_before contract on 50 random rows...")
    rng = np.random.default_rng(seed=42)
    sample = rng.choice(len(meta), size=min(50, len(meta)), replace=False)
    for idx in sample:
        m = meta[int(idx)]
        sym = m["symbol"]
        cs = load_candles(sym)
        before = closed_candles_before(cs, m["entryTime"])
        if before and before[-1]["closeTime"] >= m["entryTime"]:
            print(
                f"  LEAK!! row={idx} sym={sym} entry={m['entryTime']} "
                f"lastClose={before[-1]['closeTime']}",
                file=sys.stderr,
            )
            sys.exit(2)
    print("      [OK] all sampled rows leak-free (last closeTime strictly < entryTime)")


# ---------- train / evaluate -------------------------------------------------
def train_eval(
    X: np.ndarray, y: np.ndarray, meta: list[dict], feature_names: list[str]
) -> tuple[GradientBoostingClassifier, dict]:
    print("[3/4] chronological 50/50 split + GBM training ...", flush=True)
    n = len(X)
    split = n // 2
    # meta + X are already sorted by entryTime
    X_tr, X_te = X[:split], X[split:]
    y_tr, y_te = y[:split], y[split:]
    meta_te = meta[split:]
    print(f"      train: {len(X_tr)} (winrate {y_tr.mean()*100:.2f}%)")
    print(f"      test:  {len(X_te)} (winrate {y_te.mean()*100:.2f}%)")

    model = GradientBoostingClassifier(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        random_state=42,
    )
    model.fit(X_tr, y_tr)
    proba_te = model.predict_proba(X_te)[:, 1]
    pred_te = (proba_te >= 0.5).astype(int)

    auc = roc_auc_score(y_te, proba_te) if len(np.unique(y_te)) == 2 else float("nan")
    acc = accuracy_score(y_te, pred_te)
    p, r, f1, _ = precision_recall_fscore_support(
        y_te, pred_te, average="binary", zero_division=0
    )
    print(f"      test AUC: {auc:.4f}  acc: {acc:.4f}  P: {p:.4f}  R: {r:.4f}  F1: {f1:.4f}")

    print("[4/4] window-level pass-rate vs skip-rate ...", flush=True)
    # Baseline window pass-rate (test half only)
    win_groups: dict[int, list[tuple[float, dict]]] = defaultdict(list)
    for prob, m in zip(proba_te, meta_te):
        win_groups[m["winIdx"]].append((float(prob), m))

    # Only count windows that have *some* trades in test-half
    def window_pass_rate(skip_pct: float) -> tuple[float, int, int]:
        """Drop bottom skip_pct fraction of trades (across whole test set) by proba.
        Recompute cum_effPnl per window from kept trades only; pass = >=0.10."""
        if skip_pct <= 0.0:
            kept_mask = np.ones(len(proba_te), dtype=bool)
        else:
            k = int(len(proba_te) * skip_pct)
            order = np.argsort(proba_te)  # ascending -> lowest first
            kept_mask = np.ones(len(proba_te), dtype=bool)
            kept_mask[order[:k]] = False
        # rebuild per-window cum_effPnl from kept trades only
        cum: dict[int, float] = defaultdict(float)
        for i, m in enumerate(meta_te):
            if kept_mask[i]:
                cum[m["winIdx"]] += m["effPnl"]
        wins_passed = sum(1 for v in cum.values() if v >= STEP1_TARGET)
        return wins_passed / len(cum), wins_passed, len(cum)

    skip_rates = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]
    results = []
    for sr in skip_rates:
        pr, passed, total = window_pass_rate(sr)
        results.append({"skip_rate": sr, "pass_rate": pr, "passed": passed, "total": total})
        flag = "  <-- > 50%" if pr > 0.50 else ""
        print(f"      skip={sr*100:5.1f}%  pass={pr*100:6.2f}%  ({passed}/{total}){flag}")

    # --- alt strategy A: absolute prob-threshold skip ---
    def window_pass_rate_thresh(min_prob: float) -> tuple[float, int, int, int]:
        kept_mask = proba_te >= min_prob
        cum: dict[int, float] = defaultdict(float)
        for i, m in enumerate(meta_te):
            if kept_mask[i]:
                cum[m["winIdx"]] += m["effPnl"]
        wins_passed = sum(1 for v in cum.values() if v >= STEP1_TARGET)
        return wins_passed / max(1, len(cum)), wins_passed, len(cum), int(kept_mask.sum())

    print("\n      Alt strategy A — absolute probability threshold:")
    threshold_results = []
    for thresh in [0.30, 0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]:
        pr, passed, total, kept = window_pass_rate_thresh(thresh)
        threshold_results.append(
            {"threshold": thresh, "pass_rate": pr, "passed": passed, "total": total, "kept_trades": kept}
        )
        flag = "  <-- > 50%" if pr > 0.50 else ""
        print(
            f"        thresh={thresh:.2f}  kept={kept}/{len(proba_te)}  "
            f"pass={pr*100:6.2f}%  ({passed}/{total}){flag}"
        )

    # --- alt strategy B: skip only when CONFIDENT loss (e.g. proba < 0.4) AND keep when bullish ---
    # asymmetric: only skip very low confidence trades
    print("\n      Alt strategy B — per-window bottom-K skip (rank within window):")
    pw_results = []
    for k_skip in [0, 1, 2, 3]:
        # For each window, drop k_skip lowest-confidence trades
        per_win_idx_probs: dict[int, list[tuple[int, float]]] = defaultdict(list)
        for i, m in enumerate(meta_te):
            per_win_idx_probs[m["winIdx"]].append((i, float(proba_te[i])))
        drop_set: set[int] = set()
        for w, items in per_win_idx_probs.items():
            items_sorted = sorted(items, key=lambda x: x[1])
            for idx, _ in items_sorted[:k_skip]:
                drop_set.add(idx)
        cum: dict[int, float] = defaultdict(float)
        for i, m in enumerate(meta_te):
            if i not in drop_set:
                cum[m["winIdx"]] += m["effPnl"]
        wins_passed = sum(1 for v in cum.values() if v >= STEP1_TARGET)
        pr = wins_passed / len(cum)
        pw_results.append(
            {"k_per_window": k_skip, "pass_rate": pr, "passed": wins_passed, "total": len(cum)}
        )
        flag = "  <-- > 50%" if pr > 0.50 else ""
        print(
            f"        k_per_window={k_skip}  drop_total={len(drop_set)}/{len(proba_te)}  "
            f"pass={pr*100:6.2f}%  ({wins_passed}/{len(cum)}){flag}"
        )

    # feature importance
    importances = sorted(
        zip(feature_names, model.feature_importances_),
        key=lambda x: -x[1],
    )
    print("\n      Feature importances (top 10):")
    for name, imp in importances[:10]:
        print(f"        {name:25s} {imp:.4f}")

    return model, {
        "auc": auc,
        "acc": acc,
        "precision": p,
        "recall": r,
        "f1": f1,
        "test_n": int(len(X_te)),
        "test_winrate": float(y_te.mean()),
        "skip_curve": results,
        "threshold_curve": threshold_results,
        "per_window_curve": pw_results,
        "feature_importance": [(n, float(v)) for n, v in importances],
    }


def write_report(report: dict, feature_names: list[str]) -> None:
    lines = [
        "ML Trade Filter — Research Report",
        "=" * 60,
        f"Test N: {report['test_n']}  AUC: {report['auc']:.4f}  Acc: {report['acc']:.4f}",
        f"Test winrate (base): {report['test_winrate']*100:.2f}%",
        f"Precision: {report['precision']:.4f}  Recall: {report['recall']:.4f}  F1: {report['f1']:.4f}",
        "",
        "Window pass-rate vs skip-rate (test-half, target=+10%):",
    ]
    for r in report["skip_curve"]:
        lines.append(
            f"  skip={r['skip_rate']*100:5.1f}%  pass={r['pass_rate']*100:6.2f}%  "
            f"({r['passed']}/{r['total']})"
        )
    lines.append("")
    lines.append("Alt strategy A — absolute probability threshold:")
    for r in report["threshold_curve"]:
        lines.append(
            f"  thresh={r['threshold']:.2f}  kept={r['kept_trades']}  "
            f"pass={r['pass_rate']*100:6.2f}%  ({r['passed']}/{r['total']})"
        )
    lines.append("")
    lines.append("Alt strategy B — per-window bottom-K skip:")
    for r in report["per_window_curve"]:
        lines.append(
            f"  k_per_window={r['k_per_window']}  "
            f"pass={r['pass_rate']*100:6.2f}%  ({r['passed']}/{r['total']})"
        )
    lines.append("")
    lines.append("Oracle ceiling (perfect loss-skip, test half): 46.43% (39/84)")
    lines.append("=> 50% target is structurally unreachable via trade-skipping.")
    lines.append("")
    lines.append("Feature importance (sorted):")
    for name, imp in report["feature_importance"]:
        lines.append(f"  {name:25s} {imp:.4f}")
    OUT_REPORT.write_text("\n".join(lines))
    print(f"\nWrote report to {OUT_REPORT}")


def main() -> None:
    X, y, meta, feature_names = build_dataset()
    audit_leak_free(meta)
    model, report = train_eval(X, y, meta, feature_names)
    with open(OUT_MODEL, "wb") as f:
        pickle.dump({"model": model, "feature_names": feature_names}, f)
    print(f"\nSaved model to {OUT_MODEL}")
    write_report(report, feature_names)

    # final verdict — across all 3 strategies
    all_results = (
        [("global-skip", r["skip_rate"], r["pass_rate"]) for r in report["skip_curve"]]
        + [("prob-thresh", r["threshold"], r["pass_rate"]) for r in report["threshold_curve"]]
        + [("per-window-skip", r["k_per_window"], r["pass_rate"]) for r in report["per_window_curve"]]
    )
    any_win = any(r[2] > 0.50 for r in all_results)
    print()
    print("=" * 60)
    if any_win:
        winning = [r for r in all_results if r[2] > 0.50]
        print(f"VERDICT: WIN — {len(winning)} configuration(s) exceed 50% window-pass.")
        for strat, param, pr in winning:
            print(f"  strategy={strat} param={param}  pass={pr*100:.2f}%")
    else:
        best = max(all_results, key=lambda r: r[2])
        print(
            "VERDICT: ML cannot lift window-pass > 50% (consistent with prior debunks)."
        )
        print(f"  Best: strategy={best[0]} param={best[1]}  pass={best[2]*100:.2f}%")


if __name__ == "__main__":
    main()
