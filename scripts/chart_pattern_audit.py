#!/usr/bin/env python3
"""Chart-level pattern audit. For each window:
  - Cross-asset correlation (BTC vs ETH/SOL/BNB/major alts)
  - Funding-rate extremes (max abs funding seen pre-challenge)
  - BTC bar patterns (doji-frequency, gap-frequency, big-wick-frequency)
  - Range-compression (Bollinger-Band-width-percentile)
  - Trending vs choppy regime classifier

Find any feature that separates the 76 unq-fail from 66 pass globally.
"""
from __future__ import annotations
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

CACHE = Path(__file__).resolve().parent / "cache_bakeoff"
WIN_PATH = CACHE / "cluster_audit/champion.jsonl"
TRADE_PATH = CACHE / "cluster_audit/champion_trades.jsonl"

ASSETS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "LINKUSDT", "AVAXUSDT"]


def load_candles_2h(symbol: str):
    try:
        with (CACHE / f"{symbol}_2h.json").open() as f:
            return sorted(json.load(f), key=lambda c: c["openTime"])
    except FileNotFoundError:
        return None


def load_funding(symbol: str):
    try:
        with (CACHE / f"{symbol}_funding.json").open() as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def load_windows_trades():
    windows = {}
    with WIN_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            windows[r["win_idx"]] = r
    trades_by_w = defaultdict(list)
    with TRADE_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            trades_by_w[r["winIdx"]].append(r)
    for k in trades_by_w:
        trades_by_w[k].sort(key=lambda t: t["entryTime"])
    return windows, trades_by_w


def returns_in_window(candles, t_start, t_end):
    bars = [c for c in candles if t_start <= c["openTime"] < t_end]
    if len(bars) < 5:
        return []
    closes = [c["close"] for c in bars]
    return [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes))]


def pearson(xs, ys):
    if len(xs) < 3 or len(xs) != len(ys):
        return 0.0
    mx = statistics.mean(xs)
    my = statistics.mean(ys)
    num = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    dx = sum((x-mx)**2 for x in xs) ** 0.5
    dy = sum((y-my)**2 for y in ys) ** 0.5
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


def bar_patterns(candles, t_start, t_end):
    """Compute doji/wick/range stats."""
    bars = [c for c in candles if t_start <= c["openTime"] < t_end]
    if not bars:
        return None
    doji_count = 0  # body < 30% of range
    big_wick_count = 0  # one wick > 50% of range
    bull_engulf = 0
    bear_engulf = 0
    for i, b in enumerate(bars):
        rng = b["high"] - b["low"]
        if rng == 0:
            continue
        body = abs(b["close"] - b["open"])
        if body / rng < 0.3:
            doji_count += 1
        upper_wick = b["high"] - max(b["close"], b["open"])
        lower_wick = min(b["close"], b["open"]) - b["low"]
        if upper_wick / rng > 0.5 or lower_wick / rng > 0.5:
            big_wick_count += 1
        # Engulfing
        if i > 0:
            prev = bars[i-1]
            if b["close"] > b["open"] and prev["close"] < prev["open"] and b["close"] > prev["open"] and b["open"] < prev["close"]:
                bull_engulf += 1
            elif b["close"] < b["open"] and prev["close"] > prev["open"] and b["close"] < prev["open"] and b["open"] > prev["close"]:
                bear_engulf += 1
    n = len(bars)
    return {
        "doji_frac": doji_count / n,
        "big_wick_frac": big_wick_count / n,
        "engulf_total": bull_engulf + bear_engulf,
        "n_bars": n,
    }


def funding_extremes(funding_records, t_start, t_end):
    rates = []
    for r in funding_records:
        ts = r.get("fundingTime") or r.get("time")
        if ts is None:
            continue
        if t_start <= ts < t_end:
            rate = r.get("fundingRate") or r.get("rate")
            if rate is not None:
                try:
                    rates.append(abs(float(rate)))
                except (TypeError, ValueError):
                    pass
    if not rates:
        return None
    return {
        "max_abs_funding": max(rates) * 100,
        "mean_abs_funding": statistics.mean(rates) * 100,
        "n_events": len(rates),
    }


def main():
    print("Loading candles...")
    candles = {s: load_candles_2h(s) for s in ASSETS}
    if not candles["BTCUSDT"]:
        print("BTCUSDT candles missing!")
        return
    print("Loading funding...")
    funding = {s: load_funding(s) for s in ASSETS}
    btc_funding = funding["BTCUSDT"] or []
    windows, trades_by_w = load_windows_trades()
    print(f"Windows: {len(windows)}, BTC bars: {len(candles['BTCUSDT'])}")
    print()

    rows = []
    for w_idx, w in windows.items():
        trades = trades_by_w.get(w_idx, [])
        if not trades:
            continue
        t_start = trades[0]["entryTime"]
        t_end_pre = t_start  # for pre-window analysis
        t_pre_start = t_start - 7 * 24 * 3_600_000
        t_end_in = t_start + 30 * 24 * 3_600_000

        # Cross-asset correlation: pairwise correlations of 2h log-returns, pre-window
        rets = {}
        for s in ASSETS:
            if candles[s]:
                rets[s] = returns_in_window(candles[s], t_pre_start, t_start)
        # Compute pairwise corr (BTC vs others)
        btc_ret = rets.get("BTCUSDT", [])
        corrs = []
        if btc_ret and len(btc_ret) >= 5:
            for s in ASSETS:
                if s == "BTCUSDT": continue
                other = rets.get(s, [])
                if len(other) == len(btc_ret) and len(other) >= 5:
                    corrs.append(pearson(btc_ret, other))
        avg_corr = statistics.mean(corrs) if corrs else 0.0

        # Bar patterns in pre-window
        bp = bar_patterns(candles["BTCUSDT"], t_pre_start, t_start)
        # Funding extremes pre-window
        fund = funding_extremes(btc_funding, t_pre_start, t_start)

        rows.append({
            "win_idx": w_idx,
            "passed": w["passed"],
            "qualified": w.get("qualified_at_start", False),
            "first_cluster_size": w.get("first_cluster_size") or 0,
            "first_cluster_majors": w.get("first_cluster_majors") or 0,
            "n_trades": len(trades),
            "btc_alt_corr": avg_corr,
            "doji_frac": bp["doji_frac"] if bp else 0,
            "big_wick_frac": bp["big_wick_frac"] if bp else 0,
            "engulf_total": bp["engulf_total"] if bp else 0,
            "max_funding": fund["max_abs_funding"] if fund else 0,
            "mean_funding": fund["mean_abs_funding"] if fund else 0,
        })

    # New gate
    qp = [r for r in rows if r["first_cluster_size"]>=10 and r["first_cluster_majors"]>=2 and r["passed"]]
    qf = [r for r in rows if r["first_cluster_size"]>=10 and r["first_cluster_majors"]>=2 and not r["passed"]]
    up = [r for r in rows if not (r["first_cluster_size"]>=10 and r["first_cluster_majors"]>=2) and r["passed"]]
    uf = [r for r in rows if not (r["first_cluster_size"]>=10 and r["first_cluster_majors"]>=2) and not r["passed"]]
    print(f"qp={len(qp)} qf={len(qf)} up={len(up)} uf={len(uf)}")
    print()

    def stats(g, k):
        vs = [r[k] for r in g]
        if not vs: return "—"
        return f"med={statistics.median(vs):+6.3f} mean={statistics.mean(vs):+6.3f}"

    METRICS = ["btc_alt_corr", "doji_frac", "big_wick_frac", "engulf_total",
               "max_funding", "mean_funding"]

    print(f"{'metric':18s} | {'ALL PASS (qp+up)':30s} | {'ALL FAIL (qf+uf)':30s} | ratio")
    print('-'*105)
    all_pass = qp + up
    all_fail = qf + uf
    for m in METRICS:
        if not all_pass or not all_fail: continue
        mp = statistics.mean([r[m] for r in all_pass])
        mf = statistics.mean([r[m] for r in all_fail])
        ratio = mf/mp if abs(mp) > 0.001 else float('inf')
        tag = "  ***" if (ratio > 1.3 or ratio < 0.77) and abs(mp) > 0.001 else ""
        print(f"{m:18s} | {stats(all_pass, m):30s} | {stats(all_fail, m):30s} | {ratio:6.2f}{tag}")

    print()
    # Test btc_alt_corr as gate
    print("=== Cross-asset-correlation as filter ===")
    def cluster(r): return r["first_cluster_size"]>=10 and r["first_cluster_majors"]>=2
    def evaluate(label, rule):
        qual = [r for r in rows if rule(r)]
        if not qual: print(f"{label:55s} | qual=0"); return
        passed = sum(1 for r in qual if r["passed"])
        n = len(rows)
        print(f"{label:55s} | qual={len(qual):3d}/{n} | pass={passed:3d} cond={passed/len(qual)*100:5.1f}% unc={passed/n*100:5.1f}%")

    evaluate("cluster only", cluster)
    for t in [0.3, 0.5, 0.7, 0.8]:
        evaluate(f"cluster + btc_alt_corr >= {t}",
                 lambda r, t=t: cluster(r) and r["btc_alt_corr"] >= t)
        evaluate(f"cluster + btc_alt_corr <= {t}",
                 lambda r, t=t: cluster(r) and r["btc_alt_corr"] <= t)
    for t in [0.3, 0.5, 0.7]:
        evaluate(f"btc_alt_corr >= {t} ONLY (no cluster)",
                 lambda r, t=t: r["btc_alt_corr"] >= t)

    # Save full table
    out = CACHE / "cluster_audit/chart_metrics.csv"
    with out.open("w") as f:
        keys = ["win_idx", "passed", "qualified", "first_cluster_size", "first_cluster_majors",
                "n_trades"] + METRICS
        f.write(",".join(keys) + "\n")
        for r in rows:
            f.write(",".join(str(r[k]) for k in keys) + "\n")
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
