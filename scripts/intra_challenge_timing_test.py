#!/usr/bin/env python3
"""
2026-05-18 User-Hypothese: 'Most challenges fail/pass in first few days.
With good intra-challenge timing → 90% pass-rate'.

Test:
1. For passing windows: on which day did equity reach +10%?
2. For failing windows: on which day was the breach?
3. Can intra-challenge intervention (e.g. 'stop trading after day X') save fails?
"""
import json
from pathlib import Path
from collections import defaultdict, Counter

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

# Compute equity trajectory per window (simplified)
def cumulative_equity_by_day(win_trades):
    """Returns dict {day -> cumulative_equity}."""
    s = sorted(win_trades, key=lambda t: t["exitTime"])
    eq = 0.0
    by_day = {}
    for t in s:
        eq += t["effPnl"]
        # Use exit day (when pnl is realized)
        exit_day = t.get("day", t.get("entryDay", 1))
        by_day[exit_day] = eq
    return by_day, eq

# When do passing windows reach +10%?
print("=== When do PASSING windows reach +10%? ===")
target_day_dist = Counter()
for w in common:
    if not p1[w]["passed"]: continue
    by_day, _ = cumulative_equity_by_day(trades[w])
    # Find first day where eq >= 0.10
    target_day = None
    for d in sorted(by_day.keys()):
        if by_day[d] >= 0.10:
            target_day = d
            break
    if target_day is None:
        target_day_dist["never_reached_target"] += 1
    else:
        # Bucket: Day 1-3, 4-7, 8-14, 15-30
        if target_day <= 3:
            target_day_dist["Day 1-3"] += 1
        elif target_day <= 7:
            target_day_dist["Day 4-7"] += 1
        elif target_day <= 14:
            target_day_dist["Day 8-14"] += 1
        else:
            target_day_dist["Day 15-30"] += 1

passing = sum(1 for w in common if p1[w]["passed"])
print(f"Passing windows: {passing}/{n}")
print(f"{'Day Range':<25} {'Count':<8} {'% of passing':<12}")
for k in ["Day 1-3", "Day 4-7", "Day 8-14", "Day 15-30", "never_reached_target"]:
    n_k = target_day_dist.get(k, 0)
    print(f"  {k:<23} {n_k:<8} {n_k/max(passing,1)*100:5.1f}%")

# When do failing windows fail?
print("\n=== When do FAILING windows fail (final_day)? ===")
fail_day_dist = Counter()
for w in common:
    if p1[w]["passed"]: continue
    d = p1[w]["final_day"]
    if d <= 3:
        fail_day_dist["Day 1-3"] += 1
    elif d <= 7:
        fail_day_dist["Day 4-7"] += 1
    elif d <= 14:
        fail_day_dist["Day 8-14"] += 1
    elif d < 30:
        fail_day_dist["Day 15-29"] += 1
    else:
        fail_day_dist["Day 30 (time-out)"] += 1

failing = sum(1 for w in common if not p1[w]["passed"])
print(f"Failing windows: {failing}/{n}")
print(f"{'Day Range':<25} {'Count':<8} {'% of failing':<12}")
for k in ["Day 1-3", "Day 4-7", "Day 8-14", "Day 15-29", "Day 30 (time-out)"]:
    n_k = fail_day_dist.get(k, 0)
    print(f"  {k:<23} {n_k:<8} {n_k/max(failing,1)*100:5.1f}%")

# Critical: of failing windows, what was their equity at day X?
# Could bot have stopped at day X to avoid further loss?
print("\n=== Intra-Challenge Intervention Possibility ===")
print("Failed windows: equity trajectory")
print(f"{'Day':<8} {'AvgEq':<10} {'MedianEq':<10} {'PctAbove0':<12}")
for check_day in [1, 2, 3, 5, 7, 10, 14, 20]:
    eqs = []
    for w in common:
        if p1[w]["passed"]: continue
        by_day, _ = cumulative_equity_by_day(trades[w])
        # Find equity at or before check_day
        ds = sorted(d for d in by_day if d <= check_day)
        if ds:
            eqs.append(by_day[ds[-1]])
        else:
            eqs.append(0.0)
    if eqs:
        avg = sum(eqs) / len(eqs)
        med = sorted(eqs)[len(eqs)//2]
        above0 = sum(1 for e in eqs if e > 0) / len(eqs) * 100
        print(f"  Day {check_day:<5} {avg*100:+7.2f}%   {med*100:+7.2f}%   {above0:5.1f}%")

# Test: can "stop trading after day X if equity > 0" save fails?
print("\n=== Hypothesis: stop trading after Day X if equity > 0 (lock-in time-pass) ===")
print("Note: FTMO requires +10% to PASS. Just having equity > 0 = time fail.")
print("So this strategy can't actually PASS more — only avoid losing time-failures.")

# Real test: can bot save windows that are PROFITABLE in early days but fail later?
print("\n=== Windows profitable at Day X but ultimately failed ===")
for check_day in [3, 5, 7, 10, 14]:
    saveable = 0
    for w in common:
        if p1[w]["passed"]: continue
        by_day, final = cumulative_equity_by_day(trades[w])
        # Equity at check_day
        ds = sorted(d for d in by_day if d <= check_day)
        if not ds: continue
        eq_at = by_day[ds[-1]]
        # If equity at check_day > +5% but ultimately failed:
        # could bot have "locked in" profits and passed?
        # FTMO: needs +10% AT END
        # If eq at check_day > 0.10 but final < 0.10 → drawdown after target
        if eq_at >= 0.10 and final < 0.10:
            saveable += 1
    print(f"  Day {check_day:>3}: {saveable:<3} windows would have passed if 'locked in early'")

# The key question: of failing windows, how many never reached +10% at all?
print("\n=== Reachable target in failed windows? ===")
never_reached = 0
reached_then_lost = 0
near_miss = 0  # got to +5% to +10%
no_progress = 0  # never above +5%
for w in common:
    if p1[w]["passed"]: continue
    by_day, _ = cumulative_equity_by_day(trades[w])
    max_eq = max(by_day.values()) if by_day else 0
    if max_eq >= 0.10:
        reached_then_lost += 1
    elif max_eq >= 0.05:
        near_miss += 1
    else:
        no_progress += 1
total_failed = sum(1 for w in common if not p1[w]["passed"])
print(f"Failed windows: {total_failed}")
print(f"  Reached +10% at some point but lost it: {reached_then_lost} ({reached_then_lost/total_failed*100:.1f}%)")
print(f"  Got near (+5% to +10%) but didn't reach: {near_miss} ({near_miss/total_failed*100:.1f}%)")
print(f"  Never above +5%: {no_progress} ({no_progress/total_failed*100:.1f}%)")
print()
print(f"If bot could 'lock in' all {reached_then_lost} that reached +10%:")
new_pass = passing + reached_then_lost
print(f"  New pass-rate: {new_pass}/{n} = {new_pass/n*100:.2f}%")
