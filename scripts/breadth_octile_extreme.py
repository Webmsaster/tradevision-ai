#!/usr/bin/env python3
"""
2026-05-17 Extreme breadth+majors gates + 8-octile walk-forward.
Push for stable >=95% AND.
"""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
TRADES = ROOT / "trades_p06" / "p06_p1_trades.jsonl"
P1_WIN = ROOT / "trades_p06" / "p06_p1_windows.jsonl"
P2_WIN = ROOT / "per_window" / "p06_ptp_8pct_25_p2.jsonl"
MAJORS = {"BTC-TREND", "ETH-TREND", "BNB-TREND", "SOL-TREND"}
TIER2 = {"AVAX-TREND", "LTC-TREND", "BCH-TREND", "XRP-TREND", "ADA-TREND", "DOT-TREND"}

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

common = sorted(set(p1) & set(p2) & set(trades.keys()))

candidates = [
    ("b>=4 & maj>=3", lambda s: len(s)>=4 and len(s&MAJORS)>=3),
    ("b>=7 & maj>=3", lambda s: len(s)>=7 and len(s&MAJORS)>=3),
    ("b>=4 & maj==4 (all)", lambda s: len(s)>=4 and len(s&MAJORS)==4),
    ("b>=8 & maj>=3", lambda s: len(s)>=8 and len(s&MAJORS)>=3),
    ("b>=8 & maj==4", lambda s: len(s)>=8 and len(s&MAJORS)==4),
    ("b>=4 & maj>=3 & tier2>=1", lambda s: len(s)>=4 and len(s&MAJORS)>=3 and len(s&TIER2)>=1),
    ("b>=7 & maj>=3 & tier2>=1", lambda s: len(s)>=7 and len(s&MAJORS)>=3 and len(s&TIER2)>=1),
    ("b>=7 & maj==4 & tier2>=1", lambda s: len(s)>=7 and len(s&MAJORS)==4 and len(s&TIER2)>=1),
    ("b>=8 & maj==4 & tier2>=1", lambda s: len(s)>=8 and len(s&MAJORS)==4 and len(s&TIER2)>=1),
    ("b>=10 & maj==4", lambda s: len(s)>=10 and len(s&MAJORS)==4),
]

def stats(kept):
    if not kept: return None
    n = len(kept)
    p1p = sum(1 for k in kept if p1[k]) / n * 100
    p2p = sum(1 for k in kept if p2[k]) / n * 100
    both = sum(1 for k in kept if p1[k] and p2[k])
    return n, p1p, p2p, both/n*100, both

print("=== Overall + 8-Octile Walk-Forward ===\n")
print(f"{'Gate':<40} {'Kept':<10} {'AND%':<8} | Octiles ----")
print("-" * 110)

n_total = len(common)
oct_size = n_total // 8

for label, pred in candidates:
    kept = [w for w in common if pred(cluster_symbols(trades[w]))]
    if not kept:
        continue
    s = stats(kept)
    if s is None:
        continue
    n, p1p, p2p, andp, both = s

    # 8 octiles
    oct_results = []
    for o in range(8):
        start = o*oct_size
        end = (o+1)*oct_size if o<7 else n_total
        ws = common[start:end]
        kp = [w for w in ws if pred(cluster_symbols(trades[w]))]
        if not kp:
            oct_results.append("--")
        else:
            and_o = sum(1 for k in kp if p1[k] and p2[k]) / len(kp) * 100
            oct_results.append(f"{and_o:4.1f}")

    oct_str = " ".join(oct_results)
    print(f"{label:<40} {n}/{n_total:<8} {andp:5.2f}%  | {oct_str}")

# Best gates with retention >= 30%
print("\n=== Top by AND%, retention >= 30% ===")
keepers = []
for label, pred in candidates:
    kept = [w for w in common if pred(cluster_symbols(trades[w]))]
    if not kept or len(kept) < n_total * 0.30:
        continue
    s = stats(kept)
    if s is None: continue
    keepers.append((s[3], label, s[0], s[1], s[2]))
keepers.sort(reverse=True)
for andp, label, n, p1p, p2p in keepers:
    print(f"  {andp:5.2f}%  {label:<40} kept={n}/{n_total} P1={p1p:.1f} P2={p2p:.1f}")
