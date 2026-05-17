#!/usr/bin/env python3
"""2026-05-17 Walk-Forward CV — split windows into 4 Quartile and measure
per-Quartile pass-rate. Detects recency-bias (Q4 >> Q1 = overfit-flag).
"""
import json
from pathlib import Path

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")
LABELS = ["A_amber","B_titanium","C_obsidian","D_topaz","E_rubin","F_sapphir","G_diamond","H_amber_ds","I_amber_atr","J_r28_v6"]

def load(label):
    p1 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p1.jsonl").read_text().splitlines() if l.strip()}
    p2 = {json.loads(l)["win_idx"]: json.loads(l)["passed"]
          for l in (OUT/f"{label}_p2.jsonl").read_text().splitlines() if l.strip()}
    keys = sorted(set(p1) & set(p2))
    return [(k, p1[k], p2[k]) for k in keys]

print("=== WALK-FORWARD QUARTILE ANALYSIS ===")
print(f"{'Config':<14}{'Q1 (early)':>11}{'Q2':>8}{'Q3':>8}{'Q4 (late)':>11}{'Mean':>8}{'Drift Q4-Q1':>14}")
print("-" * 80)
for label in LABELS:
    data = load(label)
    n = len(data)
    q_size = n // 4
    qs = [data[i*q_size:(i+1)*q_size if i<3 else n] for i in range(4)]
    rates = []
    for q in qs:
        if not q: rates.append(0); continue
        both = sum(1 for _, p1, p2 in q if p1 and p2)
        rates.append(100 * both / len(q))
    mean = sum(rates)/4
    drift = rates[3] - rates[0]
    flag = " ⚠ OVERFIT-RISK" if drift > 10 else " ✅" if abs(drift) < 5 else ""
    print(f"{label:<14}{rates[0]:>9.2f}% {rates[1]:>6.2f}% {rates[2]:>6.2f}% {rates[3]:>9.2f}% {mean:>6.2f}% {drift:>+11.2f}pp{flag}")

print()
print("Interpretation:")
print("  Drift Q4-Q1 > +10pp = recency-bias (config trained on recent data, overfit)")
print("  Drift Q4-Q1 < -10pp = strategy decay (out-of-sample degradation)")
print("  |Drift| <= 5pp = robust across time = honest")
