#!/usr/bin/env python3
"""
2026-05-18 Multi-Account-Stack empirical funded-prob (real per-window OR).
Goal: zeige ob N-stack >=90% Funded erreichen kann (with same-time trading).
"""
import json
from pathlib import Path
from itertools import combinations

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")

CONFIGS = ["A_amber", "B_titanium", "C_obsidian", "D_topaz", "E_rubin",
           "F_sapphir", "G_diamond", "H_amber_ds", "I_amber_atr", "J_r28_v6"]

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = bool(r.get("passed", False))
    return out

p1_data = {}
p2_data = {}
for cfg in CONFIGS:
    p1_path = ROOT / f"{cfg}_p1.jsonl"
    p2_path = ROOT / f"{cfg}_p2.jsonl"
    if not p1_path.exists() or not p2_path.exists():
        print(f"[skip] {cfg}")
        continue
    p1_data[cfg] = load(p1_path)
    p2_data[cfg] = load(p2_path)

# Find common windows across all configs (both phases)
all_keys = None
for cfg in p1_data:
    keys_p1 = set(p1_data[cfg].keys())
    keys_p2 = set(p2_data[cfg].keys())
    keys = keys_p1 & keys_p2
    if all_keys is None:
        all_keys = keys
    else:
        all_keys &= keys
common = sorted(all_keys) if all_keys else []
print(f"Common windows: {len(common)}")
print(f"Configs loaded: {list(p1_data.keys())}\n")

def per_config_and(cfg):
    """Per-window: passed P1 AND P2."""
    return [p1_data[cfg].get(w, False) and p2_data[cfg].get(w, False) for w in common]

# Single-config Funded-Prob
print("=== Single-Config Funded-Prob (per-window AND) ===")
single = {}
for cfg in p1_data:
    arr = per_config_and(cfg)
    single[cfg] = sum(arr) / len(arr) * 100
    print(f"  {cfg:<14} {single[cfg]:6.2f}%")

# Multi-Stack OR-aggregation
def stack_funded(cfgs):
    """In each window, at least one config passed both phases."""
    n = len(common)
    passed = 0
    for i in range(n):
        any_pass = any(p1_data[c].get(common[i], False) and p2_data[c].get(common[i], False)
                       for c in cfgs)
        if any_pass: passed += 1
    return passed / n * 100

# Confirm phase19 7-stack
phase19_7 = ["A_amber", "B_titanium", "C_obsidian", "D_topaz", "G_diamond", "H_amber_ds", "I_amber_atr"]
print(f"\n=== Phase19 best 7-stack ===")
print(f"  {' + '.join(phase19_7)}")
print(f"  Funded-Prob: {stack_funded(phase19_7):.2f}%")

# Try all 10
print(f"\n=== All 10 configs OR-aggregated ===")
print(f"  Funded-Prob: {stack_funded(CONFIGS):.2f}%")

# Try best stack by size
print(f"\n=== Best stack per size ===")
for k in range(2, len(CONFIGS) + 1):
    best = (0, None)
    for combo in combinations(CONFIGS, k):
        fp = stack_funded(list(combo))
        if fp > best[0]:
            best = (fp, combo)
    print(f"  Best {k}-stack: {best[0]:6.2f}%  {best[1]}")

# Hypothetical: if you ADD smart-timing per account, what's the max possible?
print("\n=== Notes ===")
print("Smart-timing improvement (per memory phase33):")
print("  Per-account: pass-rate when 'qualifying' = ~92% (vs ~50% blind)")
print("  But trading-OR-aggregation works only on REAL data.")
print("  Phase19 data does NOT include smart-timing per config — backtest")
print("  ran each config 'blind buy' over all 329 windows.")
print(f"  The 77.20% 7-stack is the BEST blind-buy multi-account funded-prob")
print(f"  achievable from these 10 configs.")
