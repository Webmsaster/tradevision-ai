#!/usr/bin/env python3
"""
2026-05-18 User-Idee: 'safer in den ersten Tagen, nicht so schnelle play ups
schaffen wir die Challenge in 7 Tagen mit 90% Passrate'.

Hypothesis: Bot in Day 1-3 KLEINER positions (less DL risk), Day 4+ full size.
Reduces early DL/TL breaches that kill 86.8% of failing windows.

Test on P06 trade-dump:
- For each trade with entryDay ∈ {1,2,3}: scale eff_pnl by factor f
- For entryDay >= 4: full size
- Recompute equity + pass logic
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"

def load(p):
    out = {}
    for line in Path(p).read_text().splitlines():
        if line.strip(): r=json.loads(line); out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip(): r=json.loads(line); trades[r["winIdx"]].append(r)

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)
print(f"Total windows: {n}")

def sim_early_conservative(window_trades, early_days, early_factor, late_factor=1.0):
    """Per-window equity sim with size factor varying by entry day."""
    if not window_trades: return False
    s = sorted(window_trades, key=lambda t: t["entryTime"])
    eq = 0.0
    min_eq = 0.0
    day_start_eq = {}
    for t in s:
        d = t["entryDay"]
        if d not in day_start_eq:
            day_start_eq[d] = eq
        factor = early_factor if d <= early_days else late_factor
        eq += t["effPnl"] * factor
        min_eq = min(min_eq, eq)
        # Daily loss check
        if eq - day_start_eq[d] <= -0.05:
            return False
    if min_eq <= -0.10:
        return False
    return eq >= 0.10

# Baseline (no scaling)
base_p1 = sum(1 for w in common if sim_early_conservative(trades[w], 0, 1.0, 1.0))
real_p1 = sum(1 for w in common if p1[w]["passed"])
print(f"Real P1: {real_p1}/{n} = {real_p1/n*100:.2f}%")
print(f"Sim baseline P1: {base_p1}/{n} = {base_p1/n*100:.2f}%")
print(f"(Sim is approximation — slight delta from real engine)\n")

print("=== Early Conservative Trading (size factor on Day 1 to N) ===")
print(f"{'EarlyDays':<10} {'EarlyFactor':<12} {'LateFactor':<11} {'Sim P1%':<10} {'Sim AND%':<10}")
print("-" * 60)
for early_days in [1, 2, 3, 5, 7]:
    for early_factor in [0.3, 0.5, 0.7, 0.8, 0.9, 1.0]:
        for late_factor in [1.0, 1.2, 1.5]:
            if early_factor == 1.0 and late_factor == 1.0: continue  # skip duplicate baseline
            sim_p1 = sum(1 for w in common if sim_early_conservative(trades[w], early_days, early_factor, late_factor))
            sim_and = sum(1 for w in common if sim_early_conservative(trades[w], early_days, early_factor, late_factor) and p2[w]["passed"])
            if sim_and / n * 100 < 50: continue  # skip clearly worse
            print(f"  {early_days:<8} {early_factor:<10.2f} {late_factor:<9.2f} "
                  f"{sim_p1/n*100:6.2f}%   {sim_and/n*100:6.2f}%")

# Best combinations
print(f"\n=== Top 10 configs by AND% ===")
all_combos = []
for early_days in [1, 2, 3, 5, 7]:
    for early_factor in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]:
        for late_factor in [0.8, 1.0, 1.2, 1.5, 2.0]:
            sim_and = sum(1 for w in common if sim_early_conservative(trades[w], early_days, early_factor, late_factor) and p2[w]["passed"])
            all_combos.append((sim_and/n*100, early_days, early_factor, late_factor))
all_combos.sort(reverse=True)
for and_pct, ed, ef, lf in all_combos[:10]:
    print(f"  AND={and_pct:5.2f}%  early_days={ed} early_factor={ef:.2f} late_factor={lf:.2f}")
