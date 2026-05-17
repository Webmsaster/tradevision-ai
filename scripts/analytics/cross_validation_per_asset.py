#!/usr/bin/env python3
"""2026-05-17 Per-asset Cross-Validation analysis on champion data."""
import json
from pathlib import Path
OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
LABELS = ["A_amber"]

def load(l):
    p1 = {json.loads(x)["win_idx"]: json.loads(x)["passed"] for x in (OUT/f"{l}_p1.jsonl").read_text().splitlines() if x.strip()}
    p2 = {json.loads(x)["win_idx"]: json.loads(x)["passed"] for x in (OUT/f"{l}_p2.jsonl").read_text().splitlines() if x.strip()}
    keys = sorted(set(p1) & set(p2))
    return [(k, p1[k] and p2[k]) for k in keys]

for l in LABELS:
    data = load(l)
    n = len(data)
    folds = 5
    print(f"=== {l}: {folds}-Fold Cross-Validation ===")
    fold_size = n // folds
    rates = []
    for f in range(folds):
        lo = f * fold_size
        hi = (f+1) * fold_size if f < folds-1 else n
        test = data[lo:hi]
        train = data[:lo] + data[hi:]
        tr_rate = sum(1 for _, p in train if p) / len(train) * 100
        te_rate = sum(1 for _, p in test if p) / len(test) * 100
        diff = te_rate - tr_rate
        rates.append((tr_rate, te_rate, diff))
        print(f"  fold {f}: train={tr_rate:.2f}% test={te_rate:.2f}% diff={diff:+.2f}pp")
    mean_diff = sum(d for _,_,d in rates) / folds
    print(f"  Mean diff: {mean_diff:+.2f}pp ({'⚠ OVERFIT' if abs(mean_diff)>5 else '✅ ROBUST'})")
