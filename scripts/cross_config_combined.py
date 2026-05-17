#!/usr/bin/env python3
"""
Compute Combined Funded across ALL (P1_config, P2_config) pairs.
If different configs work better for P1 vs P2, this beats same-config Combined.
"""
import json
from pathlib import Path

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
LABELS = ["A_amber", "B_titanium", "C_obsidian", "D_topaz", "E_rubin", "F_sapphir",
          "G_diamond", "H_amber_ds", "I_amber_atr", "J_r28_v6"]

def load(label):
    p1 = {}
    p2 = {}
    for line in (OUT / f"{label}_p1.jsonl").read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            p1[r["win_idx"]] = bool(r["passed"])
    for line in (OUT / f"{label}_p2.jsonl").read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            p2[r["win_idx"]] = bool(r["passed"])
    keys = sorted(set(p1) & set(p2))
    return label, [p1[k] for k in keys], [p2[k] for k in keys], keys

configs = [load(l) for l in LABELS]
# align
min_n = min(len(c[1]) for c in configs)

print(f"# windows aligned to {min_n}")
print()
print(f"=== CROSS-CONFIG COMBINED (P1_X AND P2_Y per window) ===")
print(f"{'P1_config':<14}{'P2_config':<14}{'Combined %':<12}{'P1 alone':<10}{'P2 alone':<10}")
print("-" * 70)

best = []
for p1_label, p1_arr, _, _ in configs:
    for p2_label, _, p2_arr, _ in configs:
        # per-window AND: passed P1_X AND passed P2_Y
        joint = sum(1 for i in range(min_n) if p1_arr[i] and p2_arr[i])
        rate = joint / min_n * 100
        p1_rate = sum(p1_arr[:min_n]) / min_n * 100
        p2_rate = sum(p2_arr[:min_n]) / min_n * 100
        best.append((rate, p1_label, p2_label, p1_rate, p2_rate))

best.sort(reverse=True)
for rate, p1l, p2l, p1r, p2r in best[:15]:
    print(f"  {p1l:<14}{p2l:<14}{rate:6.2f}%      {p1r:5.2f}%    {p2r:5.2f}%")
print()
print(f"WINNER: {best[0][1]} for P1 + {best[0][2]} for P2 = {best[0][0]:.2f}% Combined")
print()
print(f"Baseline same-config (A_amber): {[r for r,a,b,_,_ in best if a=='A_amber' and b=='A_amber'][0]:.2f}%")
print()

# MULTIPLICATIVE (P1_rate × P2_rate) as alternative
print(f"=== P1×P2 RATE (multiplicative, independence-assumption) ===")
m_best = []
for p1l, p1_arr, _, _ in configs:
    for p2l, _, p2_arr, _ in configs:
        p1r = sum(p1_arr[:min_n]) / min_n * 100
        p2r = sum(p2_arr[:min_n]) / min_n * 100
        m_best.append((p1r * p2r / 100, p1l, p2l, p1r, p2r))
m_best.sort(reverse=True)
for rate, p1l, p2l, p1r, p2r in m_best[:10]:
    print(f"  {p1l:<14}+{p2l:<14}{rate:6.2f}%   ({p1r:.2f} × {p2r:.2f})")
