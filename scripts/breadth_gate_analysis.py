#!/usr/bin/env python3
"""
2026-05-17 Codex Breadth-Gate Analysis.
Replicate codex finding: filter windows where first signal cluster has >= N
distinct assets. Recompute per-window AND on retained windows.

Usage:
  python3 scripts/breadth_gate_analysis.py
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"

def load_windows(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = bool(r.get("passed", False))
    return out

def load_trades():
    by_win = defaultdict(list)
    for line in TRADES.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        by_win[r["winIdx"]].append(r)
    return by_win

p1 = load_windows(P1_WIN)
p2 = load_windows(P2_WIN)
trades = load_trades()

print(f"Windows: P1={len(p1)}, P2={len(p2)}, Trades dumps={len(trades)}")

def cluster_size(trades_list, cluster_window_hours=24):
    """Number of distinct assets in the first cluster_window_hours after first entry."""
    if not trades_list:
        return 0
    trades_sorted = sorted(trades_list, key=lambda t: t["entryTime"])
    first_t = trades_sorted[0]["entryTime"]
    cutoff = first_t + cluster_window_hours * 3600 * 1000
    assets = set()
    for t in trades_sorted:
        if t["entryTime"] <= cutoff:
            assets.add(t["symbol"])
        else:
            break
    return len(assets)

# Analyze
common = sorted(set(p1) & set(p2) & set(trades.keys()))
print(f"\nCommon windows with trades: {len(common)}\n")

def passes_gate(min_breadth, cluster_window_hours=24):
    kept = []
    for w in common:
        c = cluster_size(trades[w], cluster_window_hours)
        if c >= min_breadth:
            kept.append(w)
    return kept

print(f"{'Gate':<24} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
print("-" * 60)
for cluster_hours in [12, 24, 48, 72]:
    for thresh in range(1, 10):
        kept = passes_gate(thresh, cluster_hours)
        if not kept:
            continue
        n = len(kept)
        p1_pass = sum(1 for k in kept if p1[k])
        p2_pass = sum(1 for k in kept if p2[k])
        both = sum(1 for k in kept if p1[k] and p2[k])
        label = f">={thresh} in {cluster_hours}h"
        print(f"{label:<24} {n}/{len(common):<8} {p1_pass/n*100:5.2f}%  {p2_pass/n*100:5.2f}%  {both/n*100:5.2f}%")
    print()

# Default cluster_hours=24, sweep distinct assets thresholds
print("\n=== Default cluster=24h, distinct asset thresholds ===")
print(f"{'Threshold':<12} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
for thresh in range(1, 12):
    kept = passes_gate(thresh, 24)
    if not kept:
        continue
    n = len(kept)
    both = sum(1 for k in kept if p1[k] and p2[k])
    p1_pass = sum(1 for k in kept if p1[k])
    p2_pass = sum(1 for k in kept if p2[k])
    print(f"  >= {thresh:<8} {n}/{len(common):<8} {p1_pass/n*100:5.2f}%  {p2_pass/n*100:5.2f}%  {both/n*100:5.2f}%")
