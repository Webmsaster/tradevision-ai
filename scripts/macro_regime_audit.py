#!/usr/bin/env python3
"""Macro-regime audit: for each backtest window, compute BTC-side
regime indicators (ATR%, daily range, trend strength, funding average)
and check which separate PASS from FAIL globally (not just qualified).

If a regime indicator can flag the 76 unq-fail windows BEFORE they
start, we can either:
  (a) skip-purchase those weeks (extends conditional approach)
  (b) switch to a different config / lower risk / mean-revert
"""
from __future__ import annotations
import json
import statistics
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent
CACHE = BASE / "cache_bakeoff"
WIN_PATH = CACHE / "cluster_audit/champion.jsonl"
TRADE_PATH = CACHE / "cluster_audit/champion_trades.jsonl"


def load_btc_candles():
    """BTC 2h candles."""
    with (CACHE / "BTCUSDT_2h.json").open() as f:
        return json.load(f)


def load_btc_funding():
    """BTC funding events (8h interval typically)."""
    try:
        with (CACHE / "BTCUSDT_funding.json").open() as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def load_windows():
    out = []
    with WIN_PATH.open() as f:
        for line in f:
            out.append(json.loads(line))
    return out


def load_trades_by_window():
    out = defaultdict(list)
    with TRADE_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            out[r["winIdx"]].append(r)
    for k in out:
        out[k].sort(key=lambda t: t["entryTime"])
    return out


def compute_btc_metrics(candles, t_start, t_end):
    """Slice BTC candles in window. Compute:
      - atr_pct: avg true-range as % of close
      - range_pct: (max_high - min_low) / first_close
      - return_pct: last_close / first_close - 1
      - vol_pct: std of log returns
      - up_bars_frac: fraction of bars where close > open
    """
    sliced = [c for c in candles if t_start <= c["openTime"] < t_end]
    if len(sliced) < 5:
        return None
    closes = [c["close"] for c in sliced]
    highs = [c["high"] for c in sliced]
    lows = [c["low"] for c in sliced]
    opens = [c["open"] for c in sliced]
    # True range per bar
    trs = []
    for i, c in enumerate(sliced):
        if i == 0:
            trs.append(c["high"] - c["low"])
        else:
            prev_close = sliced[i-1]["close"]
            tr = max(c["high"] - c["low"], abs(c["high"] - prev_close), abs(c["low"] - prev_close))
            trs.append(tr)
    atr_pct = statistics.mean(trs) / statistics.mean(closes) * 100
    range_pct = (max(highs) - min(lows)) / closes[0] * 100
    return_pct = (closes[-1] / closes[0] - 1) * 100
    # Log returns
    import math
    logrets = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes))]
    vol_pct = statistics.stdev(logrets) * 100 if len(logrets) > 1 else 0.0
    up_bars_frac = sum(1 for c in sliced if c["close"] > c["open"]) / len(sliced)
    # Trend strength: |return| / (vol * sqrt(n))
    trend_strength = abs(return_pct) / max(0.01, vol_pct * (len(closes) ** 0.5))
    return {
        "atr_pct": atr_pct,
        "range_pct": range_pct,
        "return_pct": return_pct,
        "vol_pct": vol_pct,
        "up_bars_frac": up_bars_frac,
        "trend_strength": trend_strength,
        "n_bars": len(sliced),
    }


def compute_btc_pre_window(candles, t_start, days_before=7):
    """BTC metrics for the 7d BEFORE window start."""
    t0 = t_start - days_before * 24 * 3_600_000
    return compute_btc_metrics(candles, t0, t_start)


def compute_funding_avg(funding_records, t_start, t_end):
    """Avg funding rate inside the window."""
    rates = []
    for r in funding_records:
        ts = r.get("fundingTime") or r.get("ts") or r.get("time") or 0
        if t_start <= ts < t_end:
            rate = r.get("fundingRate") or r.get("rate")
            if rate is not None:
                try:
                    rates.append(float(rate))
                except (TypeError, ValueError):
                    continue
    if not rates:
        return None
    return statistics.mean(rates) * 100  # to %


def main():
    btc = load_btc_candles()
    funding = load_btc_funding()
    windows = load_windows()
    trades_by_win = load_trades_by_window()

    print(f"Loaded {len(btc)} BTC bars, {len(funding)} funding events, {len(windows)} windows")
    print()

    rows = []
    for w in windows:
        idx = w["win_idx"]
        trades = trades_by_win.get(idx, [])
        if not trades:
            continue
        t_start = trades[0]["entryTime"]
        t_end_estimate = t_start + 30 * 24 * 3_600_000  # max 30 days

        btc_in = compute_btc_metrics(btc, t_start, t_end_estimate)
        btc_pre = compute_btc_pre_window(btc, t_start, days_before=7)
        fund_in = compute_funding_avg(funding, t_start, t_end_estimate)

        if not btc_in or not btc_pre:
            continue

        rows.append({
            "win_idx": idx,
            "passed": w["passed"],
            "qualified": w.get("qualified_at_start", False),
            "n_trades": len(trades),
            # Window-internal BTC
            "btc_atr_in": btc_in["atr_pct"],
            "btc_range_in": btc_in["range_pct"],
            "btc_return_in": btc_in["return_pct"],
            "btc_vol_in": btc_in["vol_pct"],
            "btc_trend_in": btc_in["trend_strength"],
            "btc_up_frac_in": btc_in["up_bars_frac"],
            # PRE-window BTC (7d before challenge purchase)
            "btc_atr_pre": btc_pre["atr_pct"],
            "btc_range_pre": btc_pre["range_pct"],
            "btc_return_pre": btc_pre["return_pct"],
            "btc_vol_pre": btc_pre["vol_pct"],
            "btc_trend_pre": btc_pre["trend_strength"],
            "btc_up_frac_pre": btc_pre["up_bars_frac"],
            "funding_in": fund_in if fund_in is not None else 0.0,
        })

    print(f"Computed BTC metrics for {len(rows)} windows")

    # Current fast broad-cluster gate: b>=10 m>=1.
    import csv
    cm = {}
    with (CACHE / "cluster_audit/cluster_metrics.csv").open() as f:
        for r in csv.DictReader(f):
            cm[int(r["win_idx"])] = (int(r["breadth_24h"]), int(r["majors_24h"]))

    def is_new_qual(idx):
        b, m = cm.get(idx, (0, 0))
        return b >= 10 and m >= 1

    qp = [r for r in rows if is_new_qual(r["win_idx"]) and r["passed"]]
    qf = [r for r in rows if is_new_qual(r["win_idx"]) and not r["passed"]]
    up = [r for r in rows if not is_new_qual(r["win_idx"]) and r["passed"]]
    uf = [r for r in rows if not is_new_qual(r["win_idx"]) and not r["passed"]]

    print(f"Buckets: qp={len(qp)} qf={len(qf)} up={len(up)} uf={len(uf)}")
    print()

    METRICS = [
        "btc_atr_in", "btc_range_in", "btc_return_in", "btc_vol_in",
        "btc_trend_in", "btc_up_frac_in",
        "btc_atr_pre", "btc_range_pre", "btc_return_pre", "btc_vol_pre",
        "btc_trend_pre", "btc_up_frac_pre", "funding_in",
    ]

    def stats(g, key):
        vals = [r[key] for r in g]
        return f"med={statistics.median(vals):+7.2f} mean={statistics.mean(vals):+7.2f}"

    print(f"{'metric':22s} | {'ALL-PASS (qp+up)':30s} | {'ALL-FAIL (qf+uf)':30s} | ratio (fail/pass)")
    print('-'*115)
    all_pass = qp + up
    all_fail = qf + uf
    for m in METRICS:
        if not all_pass or not all_fail:
            continue
        mp = statistics.mean([r[m] for r in all_pass])
        mf = statistics.mean([r[m] for r in all_fail])
        if abs(mp) < 0.01:
            ratio_str = "  —"
        else:
            ratio = mf / mp
            tag = "  ***" if (ratio > 1.3 or ratio < 0.77) and abs(mp) > 0.5 else ""
            ratio_str = f"  {ratio:6.2f}{tag}"
        print(f"{m:22s} | {stats(all_pass, m):30s} | {stats(all_fail, m):30s} |{ratio_str}")

    print()
    print(f"{'metric':22s} | {'UNQ-PASS':30s} | {'UNQ-FAIL':30s} | sep?")
    print('-'*115)
    for m in METRICS:
        if not up or not uf:
            continue
        mp = statistics.mean([r[m] for r in up])
        mf = statistics.mean([r[m] for r in uf])
        if abs(mp) < 0.01:
            ratio_str = "  —"
        else:
            ratio = mf / mp
            tag = "  ***" if (ratio > 1.3 or ratio < 0.77) and abs(mp) > 0.5 else ""
            ratio_str = f"  {ratio:6.2f}{tag}"
        print(f"{m:22s} | {stats(up, m):30s} | {stats(uf, m):30s} |{ratio_str}")

    # Save full table
    out = CACHE / "cluster_audit/macro_metrics.csv"
    keys = ["win_idx", "passed", "qualified", "n_trades"] + METRICS
    with out.open("w") as f:
        f.write(",".join(keys) + "\n")
        for r in rows:
            f.write(",".join(str(r[k]) for k in keys) + "\n")
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
