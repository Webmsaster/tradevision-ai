#!/usr/bin/env python3
"""
2026-05-18 Szenario C: User kauft Challenge wann er will. Bot wartet IN
der Challenge auf qualifying-cluster bevor er aktiv tradet.

Hypothesis: Cluster die nicht in den ersten 24h bilden, könnten in den
ersten 2-7 Tagen folgen. Bot wartet maximal D Tage. Wenn cluster kommt,
trades aggressive. Wenn nicht, trades minimal oder gar nicht.

Empirisch testen ob dieses Hybrid ≥90% Pass-Rate erreicht.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}

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

def first_cluster_day(win_trades, breadth_thresh=4, majors_thresh=3,
                     check_window_hours=24):
    """Returns the day (0-indexed from window start) when a qualifying
    cluster FIRST forms within a 24h rolling window. Returns None if no
    qualifying cluster forms during entire window."""
    if not win_trades: return None
    s = sorted(win_trades, key=lambda t: t["entryTime"])
    first_t = s[0]["entryTime"]

    # For each potential "scan start day d", check if rolling 24h window
    # starting at day d has cluster.
    for scan_day in range(0, 30):
        scan_start = first_t + scan_day * 24 * 3600 * 1000
        scan_end = scan_start + check_window_hours * 3600 * 1000
        syms, majs = set(), set()
        for t in s:
            if t["entryTime"] > scan_end:
                break
            if t["entryTime"] < scan_start:
                continue
            syms.add(t["symbol"])
            for p in MAJORS:
                if t["symbol"].startswith(p[:-6]+"-") or t["symbol"] == p:
                    majs.add(p); break
        if len(syms) >= breadth_thresh and len(majs) >= majors_thresh:
            return scan_day
    return None

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)
print(f"Total windows: {n}\n")

# Distribution: how many windows ever qualify, and on which day?
print("=== Cluster-Formation Day Distribution ===")
day_dist = defaultdict(int)
for w in common:
    d = first_cluster_day(trades[w])
    day_dist[d] += 1
for d in sorted(day_dist.keys(), key=lambda x: (x is None, x or 0)):
    n_d = day_dist[d]
    label = f"Day {d}" if d is not None else "Never qualifies"
    print(f"  {label:<20} {n_d:>4}/{n}  ({n_d/n*100:5.1f}%)")

# Now: for each "max wait days D", what's the pass-rate if bot WAITS
# until cluster forms, then trades from there?
print("\n=== Scenario C: bot waits up to D days for cluster, then trades ===")
print(f"{'Wait Max':<10} {'Triggered':<12} {'Pass-rate':<12} {'Notes':<30}")
for D in [0, 1, 2, 3, 5, 7, 14, 30]:
    # "Triggered" = bot would trade because cluster forms within first D days
    # "Pass-rate" = of those triggered windows, what % actually passed
    triggered = []
    for w in common:
        cluster_day = first_cluster_day(trades[w])
        if cluster_day is not None and cluster_day <= D:
            triggered.append(w)
    if not triggered: continue
    passed = sum(1 for w in triggered if p1[w]["passed"] and p2[w]["passed"])
    print(f"  ≤{D:<5} days  {len(triggered):>4}/{n}    "
          f"{passed/len(triggered)*100:6.2f}%      "
          f"({len(triggered)/n*100:.1f}% retention)")

# Critical question: what if bot also trades when no cluster forms?
print("\n=== Scenario C+: bot waits D days OR trades blindly if no cluster ===")
print("(Bot trades EVERY window. If cluster forms early, that's a 'good' window;")
print(" if not, bot trades anyway with degraded performance.)")
print(f"{'Wait Max':<10} {'Pass-rate':<12} {'Note':<40}")
for D in [0, 1, 2, 3, 5, 7]:
    passed_unconditional = 0
    for w in common:
        cluster_day = first_cluster_day(trades[w])
        if cluster_day is not None and cluster_day <= D:
            # Use real outcome
            if p1[w]["passed"] and p2[w]["passed"]:
                passed_unconditional += 1
        else:
            # Bot trades anyway — real outcome (could pass or fail)
            if p1[w]["passed"] and p2[w]["passed"]:
                passed_unconditional += 1
    print(f"  ≤{D:<5} days  {passed_unconditional/n*100:6.2f}%      "
          f"(= baseline 54.63% — bot's wait doesn't actually change outcome)")

print("\n=== KEY INSIGHT ===")
print("If user buys at random T0, the question is: does qualifying-cluster form?")
print("- Within day 0: ~44% of windows")
print("- Within day 7: increases marginally")
print("The 'wait then trade' strategy doesn't fix non-qualifying windows.")
print("Bot delayed-start doesn't generate alpha that wasn't there.")
