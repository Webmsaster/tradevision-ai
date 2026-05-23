#!/usr/bin/env python3
"""
2026-05-23 Stack-4 methodology sanity check (W3-25 agent finding).

Validates the TRUE-SEQUENTIAL math:
  Sanity 1: P1 grid parity across all 4 configs.
  Sanity 2: D (final_day) distribution per config.
  Sanity 3: j=i+D (current) vs j=i+D+1 (no-overlap-day) — off-by-one test.
  Sanity 4: How many P1-passers silently dropped because P2[i+D] not present.

Result documented inline. The off-by-one (offset=1) gives a -1.65pp Stack-4
correction (57.17% → 55.52%). The +1.65pp comes from P2 starting the SAME
calendar day P1 ended — both phases trade the join-day bars, biasing P2|P1
upward. The honest deploy figure is 55.52% combined-funded.
"""
import json
import os
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK3 = os.path.join(ROOT, "scripts/cache_bakeoff/stack3_bidir_mr")
STACK4 = os.path.join(ROOT, "scripts/cache_bakeoff/stack4_rubin")

def load(path):
    d={}
    for l in open(path):
        o=json.loads(l); d[o["win_idx"]]=(bool(o["passed"]), o.get("final_day"))
    return d

configs = {
    "amber": (f"{STACK3}/amber_p1.jsonl", f"{STACK3}/amber_p2.jsonl"),
    "bidir": (f"{STACK3}/bidir_p1.jsonl", f"{STACK3}/bidir_p2.jsonl"),
    "mr":    (f"{STACK3}/mr_p1.jsonl",    f"{STACK3}/mr_p2.jsonl"),
    "rubin": (f"{STACK4}/rubin_p1.jsonl", f"{STACK4}/rubin_p2.jsonl"),
}

P1 = {t: load(v[0]) for t, v in configs.items()}
P2 = {t: load(v[1]) for t, v in configs.items()}

print("=== Sanity 1: P1 grid parity ===")
ref = set(P1["amber"])
for t in ["bidir","mr","rubin"]:
    diff = set(P1[t]) ^ ref
    print(f"  {t}: |sym diff vs amber| = {len(diff)} ({'GRID-MATCH' if len(diff)==0 else 'GRID-MISMATCH'})")

print("\n=== Sanity 2: P1 D (final_day) distribution per config (passers only) ===")
for t in configs:
    Ds=[D for p,D in P1[t].values() if p]
    if not Ds: continue
    c=Counter(Ds)
    print(f"  {t}: median D={sorted(Ds)[len(Ds)//2]}, top-5 = {sorted(c.most_common(5))}")

def funded(t, i, off):
    if i not in P1[t]: return None
    p, D = P1[t][i]
    if not p: return False
    j = i + D + off
    if j not in P2[t]: return None
    return P2[t][j][0]

print("\n=== Sanity 3: j=i+D vs j=i+D+1 (off-by-one test) ===")
allk = set(P1["amber"])
for t in ["bidir","mr","rubin"]:
    allk &= set(P1[t])
keys = sorted(allk)
for offset in [0, 1]:
    per = {t: 0 for t in configs}
    n = 0
    stack = 0
    for i in keys:
        fs = {t: funded(t, i, offset) for t in configs}
        if any(v is None for v in fs.values()): continue
        n += 1
        for t in configs:
            per[t] += 1 if fs[t] else 0
        if any(fs[t] for t in configs): stack += 1
    print(f"\n  offset={offset} (j=i+D{'+1' if offset else ''})  n={n}")
    for t in configs:
        print(f"    {t:6s}  {per[t]}/{n} = {100*per[t]/n:.2f}%")
    print(f"    Stack-4 OR: {100*stack/n:.2f}%")

print("\n=== Sanity 4: P1-passers silently dropped (P2[i+D] not found) ===")
for t in configs:
    miss = 0; passes = 0
    for i in P1[t]:
        p, D = P1[t][i]
        if p:
            passes += 1
            if (i+D) not in P2[t]: miss += 1
    print(f"  {t}: {miss}/{passes} P1-passes missing P2 ({100*miss/passes:.1f}%)")
