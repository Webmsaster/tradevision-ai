#!/usr/bin/env python3
"""
2026-05-16 Phase 18 — Multi-Account 3-Stack ECHTE Berechnung.

Loads per-window pass/fail outcomes for N configs (P1 + P2), computes:
- single-account P1, P2, Combined per config
- pairwise correlation matrix on Combined outcomes
- multi-account-stack probability (true Funded-prob)
  via window-by-window OR-aggregation across configs

Funded prob (k-of-N min-1-pass) = P(at least one account passes both P1+P2
across ALL windows, equivalently per-window OR over k configs).
"""
import json
import sys
from pathlib import Path
from itertools import combinations

OUT = Path("scripts/cache_bakeoff/hunt_2026_05_16/multi_account")

def load(label):
    p1f = OUT / f"{label}_p1.jsonl"
    p2f = OUT / f"{label}_p2.jsonl"
    p1 = {}
    p2 = {}
    for line in p1f.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        p1[r["win_idx"]] = bool(r["passed"])
    for line in p2f.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        p2[r["win_idx"]] = bool(r["passed"])
    # combined = passed P1 AND passed P2 (same win_idx)
    keys = sorted(set(p1) & set(p2))
    combined = [p1[k] and p2[k] for k in keys]
    return {
        "label": label,
        "p1": sum(p1.values()) / len(p1),
        "p2": sum(p2.values()) / len(p2),
        "combined": sum(combined) / len(combined),
        "combined_arr": combined,
        "p1_arr": [p1[k] for k in keys],
        "p2_arr": [p2[k] for k in keys],
    }

def correlation(a, b):
    n = len(a)
    sa = sum(a); sb = sum(b)
    mean_a = sa / n; mean_b = sb / n
    cov = sum((a[i]-mean_a)*(b[i]-mean_b) for i in range(n)) / n
    var_a = sum((x-mean_a)**2 for x in a) / n
    var_b = sum((x-mean_b)**2 for x in b) / n
    if var_a == 0 or var_b == 0:
        return float('nan')
    return cov / (var_a * var_b) ** 0.5

def or_stack(arrays):
    """Per-window OR (at least one passes)."""
    n = len(arrays[0])
    or_vec = [any(arr[i] for arr in arrays) for i in range(n)]
    return sum(or_vec) / n

def main():
    labels = ["A_amber", "B_titanium", "C_obsidian", "D_topaz"]
    configs = [load(l) for l in labels]
    # Align all arrays to MIN length (different configs may have different
    # window counts if some windows skipped).
    min_n = min(len(c["combined_arr"]) for c in configs)
    for c in configs:
        c["combined_arr"] = c["combined_arr"][:min_n]
        c["p1_arr"] = c["p1_arr"][:min_n]
        c["p2_arr"] = c["p2_arr"][:min_n]
    print(f"# windows aligned to {min_n}")

    print("=" * 70)
    print("SINGLE-ACCOUNT (per config):")
    print(f"{'Config':<20}{'P1':>8}{'P2':>8}{'P1*P2':>10}{'PER-WIN AND':>14}")
    print("-" * 70)
    for c in configs:
        per_win_and = sum(c["combined_arr"]) / len(c["combined_arr"])
        mult = c["p1"] * c["p2"]
        print(f"{c['label']:<20}{c['p1']*100:>7.2f}%{c['p2']*100:>7.2f}%"
              f"{mult*100:>9.2f}%{per_win_and*100:>13.2f}%")

    print("\nNOTE: P1*P2 = independence-assumption (low estimate).")
    print("PER-WIN AND = same window passes both P1 AND P2 (high estimate, regime-coupled).")

    print("\n" + "=" * 70)
    print("PAIRWISE CORRELATION (per-window AND-arrays):")
    n_arr = [c["combined_arr"] for c in configs]
    print(f"{'':<14}" + "".join(f"{l:<14}" for l in labels))
    for i, c in enumerate(configs):
        row = f"{c['label']:<14}"
        for j in range(len(configs)):
            if i == j:
                row += f"{'1.000':<14}"
            else:
                corr = correlation(n_arr[i], n_arr[j])
                row += f"{corr:>5.3f}         "
        print(row)

    print("\n" + "=" * 70)
    print("MULTI-ACCOUNT STACK Funded-Probability (per-window OR aggregation):")
    print("(Stack = at least ONE account passes both P1+P2 in same window)")
    print("-" * 70)
    for k in [2, 3, 4]:
        if k > len(configs): continue
        print(f"\n=== {k}-Stack Funded-Probabilities ===")
        best = 0
        best_combo = None
        for combo in combinations(range(len(configs)), k):
            arrs = [n_arr[i] for i in combo]
            prob = or_stack(arrs)
            labels_in = ",".join(configs[i]['label'] for i in combo)
            print(f"  {labels_in:<55}: {prob*100:6.2f}%")
            if prob > best:
                best = prob
                best_combo = combo
        if best_combo is not None:
            best_labels = ",".join(configs[i]['label'] for i in best_combo)
            print(f"  ★ BEST: {best_labels} = {best*100:.2f}%")

    print("\n" + "=" * 70)
    print("INDEPENDENCE-ASSUMED PROBABILITY (mathematical max):")
    print("-" * 70)
    for k in [2, 3, 4]:
        if k > len(configs): continue
        for combo in combinations(range(len(configs)), k):
            indep = 1 - 1.0
            indep = 1.0
            for i in combo:
                indep *= (1 - configs[i]['combined'])
            indep_funded = 1 - indep
            labels_in = ",".join(configs[i]['label'] for i in combo)
            print(f"  {k}-stack {labels_in:<55}: {indep_funded*100:6.2f}% (independence)")

if __name__ == "__main__":
    main()
