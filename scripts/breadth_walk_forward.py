#!/usr/bin/env python3
"""
2026-05-17 Walk-forward stability check for Breadth-Gate.
Codex found >=6 assets in first 24h cluster → 69.96% AND.
Verify it's stable across 4 quartiles (no era-dependence).
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

p1 = load_windows(P1_WIN)
p2 = load_windows(P2_WIN)

trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_size(trades_list, window_hours=24):
    if not trades_list:
        return 0
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + window_hours * 3600 * 1000
    return len({t["symbol"] for t in s if t["entryTime"] <= cutoff})

def cluster_latency_days(trades_list):
    """How many days from window start until first signal?"""
    if not trades_list:
        return None
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    return s[0]["entryDay"]

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)
quartile_size = n // 4

print(f"=== Walk-forward Stability Test ===")
print(f"Total windows: {n}, quartile size: {quartile_size}\n")

for thresh in [4, 5, 6, 7]:
    print(f"\n--- Breadth >= {thresh} in 24h cluster ---")
    print(f"{'Quartile':<12} {'N':<8} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8}")
    for q in range(4):
        start = q * quartile_size
        end = (q+1) * quartile_size if q < 3 else n
        windows = common[start:end]
        kept = [w for w in windows if cluster_size(trades[w], 24) >= thresh]
        if not kept:
            print(f"Q{q+1:<11} {len(windows):<8} 0          0      0      0")
            continue
        nk = len(kept)
        p1_p = sum(1 for k in kept if p1[k]) / nk * 100
        p2_p = sum(1 for k in kept if p2[k]) / nk * 100
        and_p = sum(1 for k in kept if p1[k] and p2[k]) / nk * 100
        print(f"Q{q+1:<11} {len(windows):<8} {nk}/{len(windows):<8} {p1_p:5.2f}%  {p2_p:5.2f}%  {and_p:5.2f}%")

# Latency analysis: when does the cluster form?
print("\n=== Cluster Latency (in days from window start) ===")
print("How quickly does the first signal form?")
day_dist = defaultdict(int)
for w in common:
    d = cluster_latency_days(trades[w])
    if d is not None:
        day_dist[d] += 1
for d in sorted(day_dist.keys())[:10]:
    print(f"Day {d}: {day_dist[d]} windows")

# Time from first signal until breadth=6 is reached
print("\n=== Time to reach breadth=6 (in hours) ===")
def hours_to_breadth(trades_list, target_breadth):
    if not trades_list:
        return None
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    assets = set()
    start = s[0]["entryTime"]
    for t in s:
        assets.add(t["symbol"])
        if len(assets) >= target_breadth:
            return (t["entryTime"] - start) / 3600000
    return None

hours_dist = []
for w in common:
    h = hours_to_breadth(trades[w], 6)
    if h is not None:
        hours_dist.append(h)
hours_dist.sort()
if hours_dist:
    print(f"  Windows reaching breadth=6: {len(hours_dist)}/{len(common)}")
    print(f"  Median time: {hours_dist[len(hours_dist)//2]:.1f}h")
    print(f"  P25: {hours_dist[len(hours_dist)//4]:.1f}h, P75: {hours_dist[len(hours_dist)*3//4]:.1f}h")
    print(f"  Within 24h: {sum(1 for h in hours_dist if h <= 24)}/{len(hours_dist)}")
    print(f"  Within 12h: {sum(1 for h in hours_dist if h <= 12)}/{len(hours_dist)}")
