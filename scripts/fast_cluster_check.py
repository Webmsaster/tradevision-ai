#!/usr/bin/env python3
"""
2026-05-17 Letzter Versuch: Schnellere Cluster-Detection.
Wenn schon nach 6h klar ob qualifying → bot kann RECHTZEITIG (vor DL/TL fails)
reagieren. Vielleicht ist 6h-Cluster ein guter Frühindikator.
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
            out[r["win_idx"]] = r
    return out

p1 = load(P1_WIN)
p2 = load(P2_WIN)
trades = defaultdict(list)
for line in TRADES.read_text().splitlines():
    if line.strip():
        r = json.loads(line)
        trades[r["winIdx"]].append(r)

def cluster_features(trades_list, window_hours):
    """Compute breadth + majors count in first `window_hours` after first entry."""
    if not trades_list:
        return 0, 0
    s = sorted(trades_list, key=lambda t: t["entryTime"])
    cutoff = s[0]["entryTime"] + window_hours*3600*1000
    syms = set()
    majs = set()
    for t in s:
        if t["entryTime"] > cutoff:
            break
        syms.add(t["symbol"])
        for p in MAJORS:
            if t["symbol"].startswith(p[:-6] + "-") or t["symbol"] == p:
                majs.add(p)
                break
    return len(syms), len(majs)

# Compare cluster sizes at different time horizons vs final outcome
common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)

print(f"=== Cluster Size at Various Horizons vs Final AND-Pass ===\n")
for hours in [4, 6, 8, 12, 24]:
    print(f"\n--- Horizon: {hours}h ---")
    print(f"{'Gate':<20} {'Kept':<10} {'AND-pass%':<10}")
    for b in [2, 3, 4, 5, 6, 7]:
        for m in [1, 2, 3]:
            if m > b: continue
            kept = [w for w in common
                    if cluster_features(trades[w], hours) >= (b, m)]
            # Correct: distinct check via tuple
            kept = []
            for w in common:
                sb, sm = cluster_features(trades[w], hours)
                if sb >= b and sm >= m:
                    kept.append(w)
            if not kept: continue
            n_kept = len(kept)
            andp = sum(1 for w in kept if p1[w]["passed"] and p2[w]["passed"]) / n_kept * 100
            if andp >= 80:  # only show strong ones
                print(f"  b>={b} m>={m:<8} {n_kept}/{n:<5} {andp:6.2f}%")

# Best gate at each horizon
print("\n=== Best Gate per Horizon (max AND%, min 100 windows) ===")
print(f"{'Hours':<6} {'BestGate':<20} {'Kept':<8} {'AND%':<8}")
for hours in [2, 4, 6, 8, 12, 24]:
    best = None
    for b in range(2, 10):
        for m in range(1, 5):
            if m > b: continue
            kept = []
            for w in common:
                sb, sm = cluster_features(trades[w], hours)
                if sb >= b and sm >= m:
                    kept.append(w)
            if len(kept) < 100: continue
            andp = sum(1 for w in kept if p1[w]["passed"] and p2[w]["passed"]) / len(kept) * 100
            if best is None or andp > best[2]:
                best = (f"b>={b} m>={m}", len(kept), andp)
    if best:
        print(f"  {hours:<4}h {best[0]:<18} {best[1]}/{n:<6} {best[2]:6.2f}%")
