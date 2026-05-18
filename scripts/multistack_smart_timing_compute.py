#!/usr/bin/env python3
"""
2026-05-18 Multi-Stack + Smart-Timing empirical aggregation.

Each window: bot tries N configs. Per config, only buys if config's
qualifying flag is true (= bot decided "buy this account at this time").
Window is FUNDED if at least one config bought AND passed both phases.

This is the empirical test of "bot orchestrates multi-account with
smart-timing per account".
"""
import json
import sys
from pathlib import Path
from itertools import combinations

if len(sys.argv) < 2:
    print("usage: multistack_smart_timing_compute.py <data-dir>")
    sys.exit(1)

DIR = Path(sys.argv[1])
CONFIGS = ["A_amber", "B_titanium", "C_obsidian", "D_topaz",
           "G_diamond", "H_amber_ds", "I_amber_atr"]

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["win_idx"]] = r
    return out

# Load all 14 jsonls
data = {}
for cfg in CONFIGS:
    p1 = DIR / f"{cfg}_p1.jsonl"
    p2 = DIR / f"{cfg}_p2.jsonl"
    if not p1.exists() or not p2.exists():
        print(f"[skip] {cfg} — missing files")
        continue
    data[cfg] = {"p1": load(p1), "p2": load(p2)}

if not data:
    print("No data loaded.")
    sys.exit(1)

# Find common windows
common = None
for cfg in data:
    keys_p1 = set(data[cfg]["p1"].keys())
    keys_p2 = set(data[cfg]["p2"].keys())
    keys = keys_p1 & keys_p2
    common = keys if common is None else common & keys
common = sorted(common) if common is not None else []
n = len(common)
print(f"Common windows: {n}\n")

def cfg_buys(cfg, w):
    """Does this config's bot 'buy' (= qualified_at_start)?"""
    return data[cfg]["p1"].get(w, {}).get("qualified_at_start", False)

def cfg_passes_both(cfg, w):
    return (data[cfg]["p1"].get(w, {}).get("passed", False) and
            data[cfg]["p2"].get(w, {}).get("passed", False))

def cfg_qualified_and_passed(cfg, w):
    """The bot bought this config AND it passed."""
    p1d = data[cfg]["p1"].get(w, {})
    p2d = data[cfg]["p2"].get(w, {})
    # Note: P2 may not have qualified_at_start aligned, use P1 as gate
    bought = p1d.get("qualified_at_start", False) and p2d.get("qualified_at_start", False)
    passed = p1d.get("passed", False) and p2d.get("passed", False)
    return bought and passed

print("=== Per-Config Stats (Smart-Timing Active) ===")
print(f"{'Config':<14} {'Bought':<10} {'Passed':<10} {'Pass-of-Bought%':<12}")
for cfg in data:
    bought = sum(1 for w in common if cfg_buys(cfg, w))
    passed = sum(1 for w in common if cfg_qualified_and_passed(cfg, w))
    print(f"  {cfg:<12} {bought:>4}/{n}    {passed:>4}/{bought:<6}   "
          f"{passed/max(bought,1)*100:5.2f}%")

print()

# Multi-Stack OR: window is funded if any config bought AND passed
def stack_funded(cfgs):
    funded = 0
    for w in common:
        if any(cfg_qualified_and_passed(c, w) for c in cfgs):
            funded += 1
    return funded / n * 100

print(f"=== Multi-Stack + Smart-Timing Funded-Prob (OR aggregation) ===")
loaded: list[str] = list(data.keys())
print(f"Loaded configs: {loaded}")

# Greedy: find best stack
all_combos_by_size = {}
print(f"\nBest k-stack by size:")
for k in range(1, len(loaded) + 1):
    best = (0, None)
    for combo in combinations(loaded, k):
        fp = stack_funded(list(combo))
        if fp > best[0]:
            best = (fp, combo)
    all_combos_by_size[k] = best
    print(f"  {k}-stack: {best[0]:6.2f}%  {best[1]}")

# Compare with naive blind-buy (no gate)
print(f"\n=== Reference: Blind-Buy (no smart-timing) ===")
def stack_blind(cfgs):
    funded = 0
    for w in common:
        if any(cfg_passes_both(c, w) for c in cfgs):
            funded += 1
    return funded / n * 100
for k in [1, 4, 7]:
    if k > len(loaded): break
    best = (0, None)
    for combo in combinations(loaded, k):
        fp = stack_blind(list(combo))
        if fp > best[0]:
            best = (fp, combo)
    print(f"  {k}-stack (blind): {best[0]:6.2f}%")

# Final verdict
max_fp = max(v[0] for v in all_combos_by_size.values())
print(f"\n=== VERDICT ===")
print(f"Max Multi-Stack + Smart-Timing Funded-Prob: {max_fp:.2f}%")
if max_fp >= 90:
    print(f"✅ Goal 90% ACHIEVED via Multi-Stack + Smart-Timing!")
elif max_fp >= 80:
    print(f"⚠️  {max_fp:.2f}% — over 77% baseline but under 90% goal")
else:
    print(f"❌ Below 90% — smart-timing didn't lift Multi-Stack enough")
