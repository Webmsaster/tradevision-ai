#!/usr/bin/env python3
"""
2026-05-18 User idea: Bot trades INTERNAL only on certain days (Mon/Wed/Fri etc).
User kauft Challenge random; Bot's interne logic filtered welche Tage tradet.

Test: für jeden Trade in P06-dump, compute DoW. Filter trades: keep nur die
an "good" Tagen. Recompute per-window equity → new pass rate.

This tests USER-IDEA: 'wenn du nur an bestimmten tagen tradest'.
"""
import json
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone

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

def trade_dow(t):
    return datetime.fromtimestamp(t["entryTime"]/1000, tz=timezone.utc).weekday()

def trade_hour(t):
    return datetime.fromtimestamp(t["entryTime"]/1000, tz=timezone.utc).hour

def trade_month(t):
    return datetime.fromtimestamp(t["entryTime"]/1000, tz=timezone.utc).month

# Per-trade DoW + outcome statistics
common = sorted(set(p1) & set(p2) & set(trades.keys()))
all_trades = [t for w in common for t in trades[w]]
print(f"Total trades: {len(all_trades)} across {len(common)} windows\n")

print("=== Trade-Outcome by Day-of-Week ===")
dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
print(f"{'DoW':<6} {'N':<7} {'Wins':<7} {'WinRate':<10} {'AvgPnL':<10} {'TotalPnL':<10}")
for d in range(7):
    sub = [t for t in all_trades if trade_dow(t) == d]
    if not sub: continue
    wins = sum(1 for t in sub if t["effPnl"] > 0)
    total_pnl = sum(t["effPnl"] for t in sub)
    avg_pnl = total_pnl / len(sub)
    print(f"  {dow_names[d]:<4} {len(sub):<7} {wins:<7} "
          f"{wins/len(sub)*100:5.2f}%   {avg_pnl*100:+7.4f}%  {total_pnl*100:+7.2f}%")

print("\n=== Trade-Outcome by Hour-of-Day (UTC) ===")
for h_range in [(0,4), (4,8), (8,12), (12,16), (16,20), (20,24)]:
    sub = [t for t in all_trades if h_range[0] <= trade_hour(t) < h_range[1]]
    if not sub: continue
    wins = sum(1 for t in sub if t["effPnl"] > 0)
    total = sum(t["effPnl"] for t in sub)
    print(f"  {h_range[0]:02d}-{h_range[1]:02d}h  n={len(sub):<5}  "
          f"WinRate={wins/len(sub)*100:5.2f}%  Total={total*100:+.2f}%")

# Now: simulate filter scenarios
def sim_filter(trade_predicate, label):
    """Per-window equity with only trades matching predicate."""
    pass_count = 0
    n = len(common)
    new_p1_pass = []
    for w in common:
        wt = [t for t in trades[w] if trade_predicate(t)]
        # Simple sum approximation (ignores precise DL/TL granularity)
        # Use real backtest pass logic as approximation
        total_pnl = sum(t["effPnl"] for t in wt)
        # Track min equity per day (rough DL approx)
        min_eq = 0.0
        eq = 0.0
        prev_day = None
        day_start_eq = {}
        s = sorted(wt, key=lambda t: t["entryTime"])
        dl_breach = False
        for t in s:
            d = t["entryDay"]
            if d not in day_start_eq:
                day_start_eq[d] = eq
            eq += t["effPnl"]
            min_eq = min(min_eq, eq)
            if eq - day_start_eq[d] <= -0.05:
                dl_breach = True
                break
        if dl_breach or min_eq <= -0.10:
            new_p1_pass.append(False)
        else:
            new_p1_pass.append(total_pnl >= 0.10)
    p1_passed = sum(new_p1_pass)
    # Combined with P2 (P2 unchanged)
    both = sum(1 for i, w in enumerate(common) if new_p1_pass[i] and p2[w]["passed"])
    print(f"  {label:<40}  P1={p1_passed}/{n}={p1_passed/n*100:5.2f}%  AND={both}/{n}={both/n*100:5.2f}%")

print("\n=== Per-Trade DoW Filter Simulations ===")
print(f"{'Filter':<40}  P1                AND")
sim_filter(lambda t: True, "Baseline (all trades)")
sim_filter(lambda t: trade_dow(t) != 3, "Drop Thu (-Thu only)")
sim_filter(lambda t: trade_dow(t) in {0,2,4}, "Mon/Wed/Fri only")
sim_filter(lambda t: trade_dow(t) in {0,2,4,6}, "Mon/Wed/Fri/Sun only")
sim_filter(lambda t: trade_dow(t) not in {1,3}, "Drop Tue+Thu")
sim_filter(lambda t: trade_dow(t) in {0,1,2,3,4}, "Weekdays only")
sim_filter(lambda t: trade_dow(t) in {5,6}, "Weekend only")
sim_filter(lambda t: trade_month(t) in {2,9,10,11,12}, "Strong months only")
sim_filter(lambda t: trade_dow(t) in {0,2,4} and trade_month(t) in {2,9,10,11,12}, "StrongDoW + StrongMonth")
sim_filter(lambda t: trade_hour(t) >= 8 and trade_hour(t) < 20, "Day hours only (8-20h UTC)")
sim_filter(lambda t: trade_dow(t) != 3 and trade_hour(t) < 8, "Drop Thu + only early hours")
