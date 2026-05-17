#!/usr/bin/env python3
"""
2026-05-17 Batch-Exposure-Cap simulation.
Naive equity-path recompute with max-N concurrent first-day trades.

Caveat: this is post-process; doesn't replay engine state (PTP, PASSLOCK,
DailyLoss/TotalLoss limits). Uses effPnl already PTP-adjusted from the
P06 (0.08:0.25) sweep. The sim approximates the *outcome* by:
1. Sort window trades by entry time.
2. Keep only first N "first-day" trades (entryDay == first observed day).
3. Sum effPnl over kept set + later-day trades.
4. Window passes if cumulative effPnl >= 0.10 AND no day breaches -0.05
   AND total never drops below -0.10.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = bool(r.get("passed", False))
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_symbols(tl, h=24):
    if not tl: return set()
    s = sorted(tl, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + h*3600*1000
    return {t["symbol"] for t in s if t["entryTime"] <= cutoff}

def sim_with_cap(trades_list, cap_n):
    """Simulate: cap first-day trades to N, keep all later-day trades.
    Pass = cumulative effPnl >= 0.10, no day breach -0.05, no -0.10 total.
    """
    if not trades_list:
        return False
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    first_day = s[0]["entryDay"]
    # First-day trades: cap to first N
    fd = [t for t in s if t["entryDay"] == first_day][:cap_n]
    later = [t for t in s if t["entryDay"] > first_day]
    kept = fd + later
    # Sort kept by entryTime, then walk equity
    kept.sort(key=lambda t: t["exitTime"])  # exitTime drives equity
    eq = 0.0
    day_eq = {}  # day -> equity at day start
    peak = 0.0
    min_eq = 0.0
    for t in kept:
        d = t["entryDay"]  # use entry day for daily-loss tracking
        if d not in day_eq:
            day_eq[d] = eq
        eq += t["effPnl"]
        peak = max(peak, eq)
        min_eq = min(min_eq, eq)
        # Daily-loss check
        if eq - day_eq[d] <= -0.05:
            return False
    # Total-loss check
    if min_eq <= -0.10:
        return False
    return eq >= 0.10

common = sorted(set(p1) & set(p2) & set(trades.keys()))

# Sanity: replay original (no cap = inf) and compare with reported pass rate
sim_pass_no_cap = sum(1 for w in common if sim_with_cap(trades[w], 999))
real_pass = sum(1 for w in common if p1[w])
print(f"=== Sanity Check (cap=999, no limit) ===")
print(f"Simulated P1 pass: {sim_pass_no_cap}/{len(common)} = {sim_pass_no_cap/len(common)*100:.2f}%")
print(f"Real P1 pass:      {real_pass}/{len(common)} = {real_pass/len(common)*100:.2f}%")
print(f"(some difference expected — sim doesn't replay engine state perfectly)\n")

# Now sweep caps × gate combinations
print("=== Batch-Cap Sweep ===")
print(f"{'Gate':<35} {'Cap':<6} {'Kept':<10} {'Sim P1%':<10} {'Real P2%':<10} {'AND%':<8}")

gates = [
    ("no_gate",           lambda s: True),
    ("b>=4_maj>=3",       lambda s: len(s)>=4 and len(s&MAJORS)>=3),
    ("b>=7_maj>=3",       lambda s: len(s)>=7 and len(s&MAJORS)>=3),
]

for gate_label, pred in gates:
    for cap in [3, 5, 7, 10, 999]:
        kept = [w for w in common if pred(cluster_symbols(trades[w]))]
        if not kept:
            continue
        sim_p1_pass = sum(1 for w in kept if sim_with_cap(trades[w], cap))
        p2_pass = sum(1 for w in kept if p2[w])
        # Real per-window AND with simulated P1
        both = sum(1 for w in kept if sim_with_cap(trades[w], cap) and p2[w])
        n = len(kept)
        print(f"{gate_label:<35} {cap:<6} {n}/{len(common):<8} "
              f"{sim_p1_pass/n*100:6.2f}%   {p2_pass/n*100:6.2f}%    {both/n*100:6.2f}%")
    print()
