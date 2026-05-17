#!/usr/bin/env python3
"""2026-05-17 Purged K-Fold Walk-Forward with Embargo.
Lopez de Prado standard for time-series ML — prevents train-test leakage."""
import json
from pathlib import Path
import sys
try:
    import numpy as np
except ImportError:
    sys.exit("install numpy")

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
LABELS = ["A_amber"]

def load(l):
    p1 = {json.loads(x)["win_idx"]: json.loads(x)["passed"] for x in (OUT/f"{l}_p1.jsonl").read_text().splitlines() if x.strip()}
    p2 = {json.loads(x)["win_idx"]: json.loads(x)["passed"] for x in (OUT/f"{l}_p2.jsonl").read_text().splitlines() if x.strip()}
    keys = sorted(set(p1) & set(p2))
    return np.array([p1[k] and p2[k] for k in keys])

def purged_kfold(n, k=5, embargo_frac=0.05):
    """Yield (train_idx, test_idx) tuples with embargo around test fold."""
    fold_size = n // k
    embargo = int(n * embargo_frac)
    for i in range(k):
        test_lo = i * fold_size
        test_hi = (i+1) * fold_size if i < k-1 else n
        train_idx = list(range(0, max(0, test_lo - embargo))) + list(range(min(n, test_hi + embargo), n))
        test_idx = list(range(test_lo, test_hi))
        yield np.array(train_idx), np.array(test_idx)

for l in LABELS:
    arr = load(l)
    n = len(arr)
    print(f"=== {l} Purged 5-Fold (embargo=5%) on {n} windows ===")
    print(f"{'Fold':>5}{'Train n':>10}{'Test n':>10}{'Train %':>10}{'Test %':>10}{'Diff':>10}")
    for fold, (tr, te) in enumerate(purged_kfold(n, k=5)):
        tr_rate = arr[tr].mean() * 100 if len(tr) > 0 else 0
        te_rate = arr[te].mean() * 100 if len(te) > 0 else 0
        diff = te_rate - tr_rate
        flag = " ⚠" if abs(diff) > 10 else ""
        print(f"{fold:>5}{len(tr):>10}{len(te):>10}{tr_rate:>9.2f}%{te_rate:>9.2f}%{diff:>+9.2f}pp{flag}")
print("\nInterpretation: |Train%-Test%| > 10pp = overfit-flag")
