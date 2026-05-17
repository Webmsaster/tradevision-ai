#!/usr/bin/env python3
"""
2026-05-17 Walk-forward stability for breadth+majors gates.
Goal verify: 90%+ stable across quartiles?
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

common = sorted(set(p1) & set(p2) & set(trades.keys()))
n = len(common)
qs = n // 4

print(f"Total: {n}, quartile size: {qs}\n")

candidates = [
    ("b>=4 & maj>=3", lambda s: len(s)>=4 and len(s&MAJORS)>=3),
    ("b>=5 & maj>=3", lambda s: len(s)>=5 and len(s&MAJORS)>=3),
    ("b>=4 & maj>=2", lambda s: len(s)>=4 and len(s&MAJORS)>=2),
    ("b>=5 & maj>=2", lambda s: len(s)>=5 and len(s&MAJORS)>=2),
    ("b>=7 & maj>=2", lambda s: len(s)>=7 and len(s&MAJORS)>=2),
    ("b>=6 & maj>=2", lambda s: len(s)>=6 and len(s&MAJORS)>=2),
    ("b>=4 & maj>=1", lambda s: len(s)>=4 and len(s&MAJORS)>=1),
    ("b>=7 & maj>=3", lambda s: len(s)>=7 and len(s&MAJORS)>=3),
]

for label, pred in candidates:
    print(f"\n--- {label} ---")
    print(f"{'Quartile':<12} {'N':<6} {'Kept':<10} {'P1%':<8} {'P2%':<8} {'AND%':<8} {'#both':<6}")
    overall_both = 0
    overall_kept = 0
    for q in range(4):
        start, end = q*qs, ((q+1)*qs if q<3 else n)
        ws = common[start:end]
        kept = [w for w in ws if pred(cluster_symbols(trades[w]))]
        if not kept:
            print(f"Q{q+1:<11} {len(ws):<6} 0/{len(ws):<8} 0       0       0       0")
            continue
        nk = len(kept)
        p1p = sum(1 for k in kept if p1[k]) / nk * 100
        p2p = sum(1 for k in kept if p2[k]) / nk * 100
        both = sum(1 for k in kept if p1[k] and p2[k])
        andp = both / nk * 100
        overall_both += both
        overall_kept += nk
        print(f"Q{q+1:<11} {len(ws):<6} {nk}/{len(ws):<8} {p1p:5.2f}%  {p2p:5.2f}%  {andp:5.2f}%  {both}")
    if overall_kept:
        print(f"OVERALL      {n:<6} {overall_kept}/{n:<8}                  {overall_both/overall_kept*100:5.2f}%  {overall_both}")
