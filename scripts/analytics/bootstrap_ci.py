#!/usr/bin/env python3
"""2026-05-17 Monte-Carlo Bootstrap Confidence Intervals on champion.

Computes 95% and 99% CI for:
- Champion per-window-AND pass-rate
- Stack-OR for 2-Stack, 3-Stack, 7-Stack

Method: resample N windows with replacement, k=10000 bootstrap iterations.
"""
import json
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("Install: pip install --user --break-system-packages numpy")
    sys.exit(1)

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
LABELS = ["A_amber","B_titanium","C_obsidian","D_topaz","E_rubin","F_sapphir","G_diamond","H_amber_ds","I_amber_atr","J_r28_v6"]

def load(label):
    p1 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p1.jsonl").read_text().splitlines() if l.strip()}
    p2 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p2.jsonl").read_text().splitlines() if l.strip()}
    keys = sorted(set(p1) & set(p2))
    return [p1[k] and p2[k] for k in keys]

print("Loading 10 configs...")
configs = {l: np.array(load(l), dtype=bool) for l in LABELS}
n = min(len(v) for v in configs.values())
configs = {l: v[:n] for l, v in configs.items()}
print(f"  {n} aligned windows")

ITERS = 10000
rng = np.random.default_rng(2026)

def bootstrap_rate(arr, iters=ITERS):
    """Resample n indices with replacement, compute pass-rate per resample."""
    n = len(arr)
    idx = rng.integers(0, n, size=(iters, n))
    rates = arr[idx].mean(axis=1) * 100  # %
    return rates

def report(name, arr):
    rates = bootstrap_rate(arr)
    mean = rates.mean()
    std = rates.std()
    p2_5 = np.percentile(rates, 2.5)
    p97_5 = np.percentile(rates, 97.5)
    p0_5 = np.percentile(rates, 0.5)
    p99_5 = np.percentile(rates, 99.5)
    point = arr.mean() * 100
    print(f"  {name:<45} {point:6.2f}%  ±{std:4.2f}  95%CI=[{p2_5:5.2f}, {p97_5:5.2f}]  99%CI=[{p0_5:5.2f}, {p99_5:5.2f}]")

print("\n=== BOOTSTRAP CI (10000 resamples) ===")
print(f"{'Config':<45} {'Mean':>6}  {'StdDev':>7}  {'95% CI':>20}  {'99% CI':>20}")
print("-" * 110)

for l in LABELS:
    report(l, configs[l])

# Stack OR for top-2, top-3, top-7
print("\n=== STACK BOOTSTRAP CI ===")
def or_arr(arrs):
    out = np.zeros(len(arrs[0]), dtype=bool)
    for a in arrs:
        out = out | a
    return out

stack_2 = or_arr([configs["A_amber"], configs["B_titanium"]])
stack_3 = or_arr([configs["A_amber"], configs["B_titanium"], configs["G_diamond"]])
stack_7 = or_arr([configs[k] for k in ["A_amber","B_titanium","C_obsidian","D_topaz","G_diamond","H_amber_ds","I_amber_atr"]])

report("2-Stack (A_amber+B_titanium)", stack_2)
report("3-Stack (A+B+G_diamond)", stack_3)
report("7-Stack (A+B+C+D+G+H+I)", stack_7)

print(f"\n  Bootstrap iterations: {ITERS}")
print(f"  Windows resampled: {n} per iter")
