#!/usr/bin/env python3
"""Cluster signature audit — for each window, compute multi-dimensional
cluster metrics from trade-level data and find which metrics best
separate PASS from FAIL.

Output: per-window metrics table + correlation analysis.
"""
from __future__ import annotations
import json
import statistics
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent / "cache_bakeoff/cluster_audit"
WIN_PATH = BASE / "champion.jsonl"
TRADE_PATH = BASE / "champion_trades.jsonl"
MAJORS = {"BTC", "ETH", "BNB", "SOL"}


def base_sym(s: str) -> str:
    """SOL-TREND → SOL, BTCUSDT → BTC."""
    head = s.split("-")[0].upper()
    if head.endswith("USDT"):
        head = head[:-4]
    return head


def load_windows() -> dict:
    out = {}
    with WIN_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out


def load_trades_by_window() -> dict:
    out = defaultdict(list)
    with TRADE_PATH.open() as f:
        for line in f:
            r = json.loads(line)
            out[r["winIdx"]].append(r)
    for k in out:
        out[k].sort(key=lambda t: t["entryTime"])
    return out


def compute_metrics(trades: list) -> dict:
    """Compute all candidate cluster metrics for one window's trades."""
    if not trades:
        return {
            "n_trades": 0,
            "breadth_24h": 0,
            "majors_24h": 0,
            "breadth_48h": 0,
            "majors_48h": 0,
            "breadth_72h": 0,
            "majors_72h": 0,
            "dir_coherence_24h": 0.0,
            "first_4h_count": 0,
            "first_8h_count": 0,
            "btc_in_first3": 0,
            "majors_in_first3": 0,
            "rolling_24h_max_breadth": 0,
            "rolling_24h_max_majors": 0,
            "rolling_24h_min_breadth_after_5": 0,
            "cluster_decay_pct": 0.0,
            "peak_to_loss_drawdown_pct": 0.0,
            "max_intra_24h_count": 0,
        }
    sorted_trades = trades  # already sorted
    t0 = sorted_trades[0]["entryTime"]

    def in_window(t, hrs):
        return (t["entryTime"] - t0) <= hrs * 3_600_000

    syms_24 = {base_sym(t["symbol"]) for t in sorted_trades if in_window(t, 24)}
    syms_48 = {base_sym(t["symbol"]) for t in sorted_trades if in_window(t, 48)}
    syms_72 = {base_sym(t["symbol"]) for t in sorted_trades if in_window(t, 72)}

    dirs_24 = [t["direction"] for t in sorted_trades if in_window(t, 24)]
    longs = sum(1 for d in dirs_24 if d == "long")
    shorts = sum(1 for d in dirs_24 if d == "short")
    # Direction coherence: |longs - shorts| / total (1.0 = all same direction)
    dir_coh = abs(longs - shorts) / max(1, longs + shorts)

    first_4h = sum(1 for t in sorted_trades if in_window(t, 4))
    first_8h = sum(1 for t in sorted_trades if in_window(t, 8))

    first3 = sorted_trades[:3]
    btc_in_first3 = 1 if any(base_sym(t["symbol"]) == "BTC" for t in first3) else 0
    majors_in_first3 = sum(
        1 for prefix in MAJORS if any(base_sym(t["symbol"]) == prefix for t in first3)
    )

    # Rolling 24h cluster metrics over the whole challenge.
    # For each trade entry, compute the breadth+majors in trailing 24h.
    rolling_breadths = []
    rolling_majors = []
    intra_24h_counts = []
    for i, t in enumerate(sorted_trades):
        cutoff = t["entryTime"] - 24 * 3_600_000
        window = [tx for tx in sorted_trades[: i + 1] if tx["entryTime"] >= cutoff]
        wsyms = {base_sym(tx["symbol"]) for tx in window}
        wmajors = wsyms & MAJORS
        rolling_breadths.append(len(wsyms))
        rolling_majors.append(len(wmajors))
        intra_24h_counts.append(len(window))

    max_rb = max(rolling_breadths) if rolling_breadths else 0
    max_rm = max(rolling_majors) if rolling_majors else 0
    # Min breadth after the first 5 trades (proxy for cluster-decay).
    after5 = rolling_breadths[5:] if len(rolling_breadths) > 5 else []
    min_rb_after = min(after5) if after5 else max_rb
    decay_pct = (max_rb - min_rb_after) / max(1, max_rb)
    max_intra = max(intra_24h_counts) if intra_24h_counts else 0

    # Equity-style accumulators (effPnl proxy — already returns weighted).
    cum = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in sorted_trades:
        cum += t.get("effPnl", 0.0)
        peak = max(peak, cum)
        dd = peak - cum
        max_dd = max(max_dd, dd)

    return {
        "n_trades": len(sorted_trades),
        "breadth_24h": len(syms_24),
        "majors_24h": len(syms_24 & MAJORS),
        "breadth_48h": len(syms_48),
        "majors_48h": len(syms_48 & MAJORS),
        "breadth_72h": len(syms_72),
        "majors_72h": len(syms_72 & MAJORS),
        "dir_coherence_24h": dir_coh,
        "first_4h_count": first_4h,
        "first_8h_count": first_8h,
        "btc_in_first3": btc_in_first3,
        "majors_in_first3": majors_in_first3,
        "rolling_24h_max_breadth": max_rb,
        "rolling_24h_max_majors": max_rm,
        "rolling_24h_min_breadth_after_5": min_rb_after,
        "cluster_decay_pct": decay_pct,
        "peak_to_loss_drawdown_pct": max_dd,
        "max_intra_24h_count": max_intra,
    }


def main():
    windows = load_windows()
    trades_by_win = load_trades_by_window()

    rows = []
    for w_idx, w in windows.items():
        m = compute_metrics(trades_by_win.get(w_idx, []))
        m["win_idx"] = w_idx
        m["passed"] = w["passed"]
        m["final_eq_pct"] = w["final_equity_pct"]
        m["final_day"] = w["final_day"]
        m["fail_reason"] = w["fail_reason"]
        m["qualified"] = w.get("qualified_at_start", False)
        rows.append(m)

    # Separate buckets
    qual_pass = [r for r in rows if r["qualified"] and r["passed"]]
    qual_fail = [r for r in rows if r["qualified"] and not r["passed"]]
    unq_pass = [r for r in rows if not r["qualified"] and r["passed"]]
    unq_fail = [r for r in rows if not r["qualified"] and not r["passed"]]

    print(f"qual+pass={len(qual_pass)} qual+fail={len(qual_fail)} "
          f"unq+pass={len(unq_pass)} unq+fail={len(unq_fail)}")
    print()

    # For each numeric metric, compare means/median across buckets
    METRICS = [
        "n_trades", "breadth_24h", "majors_24h", "breadth_48h", "majors_48h",
        "breadth_72h", "majors_72h", "dir_coherence_24h", "first_4h_count",
        "first_8h_count", "btc_in_first3", "majors_in_first3",
        "rolling_24h_max_breadth", "rolling_24h_max_majors",
        "rolling_24h_min_breadth_after_5", "cluster_decay_pct",
        "peak_to_loss_drawdown_pct", "max_intra_24h_count",
    ]

    def stats(group, key):
        vals = [r[key] for r in group]
        if not vals:
            return "—"
        return f"mean={statistics.mean(vals):6.2f} med={statistics.median(vals):6.2f}"

    print(f"{'metric':35s} | {'QUAL+PASS':30s} | {'QUAL+FAIL':30s} | sep?")
    print("-" * 110)
    for m in METRICS:
        sep = ""
        if qual_pass and qual_fail:
            mp = statistics.mean([r[m] for r in qual_pass])
            mf = statistics.mean([r[m] for r in qual_fail])
            if mp > 0 and mf > 0:
                ratio = mf / mp
                if ratio > 1.3 or ratio < 0.77:
                    sep = f"  *** RATIO {ratio:.2f}"
        print(f"{m:35s} | {stats(qual_pass, m):30s} | {stats(qual_fail, m):30s} |{sep}")

    print()
    print(f"{'metric':35s} | {'UNQ+PASS':30s} | {'UNQ+FAIL':30s} | sep?")
    print("-" * 110)
    for m in METRICS:
        sep = ""
        if unq_pass and unq_fail:
            mp = statistics.mean([r[m] for r in unq_pass])
            mf = statistics.mean([r[m] for r in unq_fail])
            if mp > 0 and mf > 0:
                ratio = mf / mp
                if ratio > 1.3 or ratio < 0.77:
                    sep = f"  *** RATIO {ratio:.2f}"
        print(f"{m:35s} | {stats(unq_pass, m):30s} | {stats(unq_fail, m):30s} |{sep}")

    # Detail: each qual+fail window
    print()
    print("--- DETAIL: every QUAL+FAIL window ---")
    for r in qual_fail:
        print(f"win={r['win_idx']:3d} eq={r['final_eq_pct']*100:+7.2f}% "
              f"day={r['final_day']:2d} fail={r['fail_reason']:11s} "
              f"b={r['breadth_24h']} m={r['majors_24h']} "
              f"4h_cnt={r['first_4h_count']:2d} dir_coh={r['dir_coherence_24h']:.2f} "
              f"max_intra={r['max_intra_24h_count']:2d} decay={r['cluster_decay_pct']:.2f}")

    print()
    print("--- DETAIL: every UNQ+PASS window (cluster-classifier missed these) ---")
    for r in unq_pass:
        print(f"win={r['win_idx']:3d} eq={r['final_eq_pct']*100:+7.2f}% "
              f"b={r['breadth_24h']} m={r['majors_24h']} "
              f"4h_cnt={r['first_4h_count']:2d} dir_coh={r['dir_coherence_24h']:.2f} "
              f"btc1st3={r['btc_in_first3']} maj1st3={r['majors_in_first3']}")

    # Save full table to CSV
    out_csv = BASE / "cluster_metrics.csv"
    with out_csv.open("w") as f:
        cols = ["win_idx", "passed", "qualified", "final_eq_pct", "final_day", "fail_reason"] + METRICS
        f.write(",".join(cols) + "\n")
        for r in rows:
            f.write(",".join(str(r[c]) for c in cols) + "\n")
    print(f"\nFull table saved: {out_csv}")


if __name__ == "__main__":
    main()
