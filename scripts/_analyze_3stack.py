#!/usr/bin/env python3
"""2026-05-19 — 3-stack analysis.

Reads all jsonl from scripts/cache_bakeoff/3stack_hunt/, finds the common
win_idx universe, computes per-config standalone pass-rate, pairwise
correlation, and best 3-config OR-aggregation.
"""
import json
import os
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HUNT_DIR = ROOT / "scripts/cache_bakeoff/3stack_hunt"


def load_jsonl(path: Path):
    """Return dict[win_idx] -> bool (passed)."""
    result = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            result[d["win_idx"]] = bool(d["passed"])
    return result


def pearson(x, y):
    """Phi/Pearson correlation between two 0/1 lists."""
    n = len(x)
    if n == 0:
        return 0.0
    sx = sum(x)
    sy = sum(y)
    sxx = sum(v * v for v in x)
    syy = sum(v * v for v in y)
    sxy = sum(a * b for a, b in zip(x, y))
    num = n * sxy - sx * sy
    den_sq = (n * sxx - sx * sx) * (n * syy - sy * sy)
    if den_sq <= 0:
        return 0.0
    return num / (den_sq ** 0.5)


def main():
    files = sorted(HUNT_DIR.glob("*.jsonl"))
    configs = {}
    for f in files:
        name = f.stem
        configs[name] = load_jsonl(f)
        print(f"  loaded {name}: {len(configs[name])} windows, "
              f"pass={sum(configs[name].values())}/{len(configs[name])} "
              f"({100*sum(configs[name].values())/max(len(configs[name]),1):.2f}%)")

    # Find COMMON window indices across ALL configs (intersection).
    # Some configs have 273 windows (full-history), some 146 — intersection
    # gives the fair comparison universe.
    common_idx = None
    for name, d in configs.items():
        keys = set(d.keys())
        common_idx = keys if common_idx is None else common_idx & keys
    common_idx = sorted(common_idx)
    n_common = len(common_idx)
    print(f"\n=== Common window universe: {n_common} windows ===\n")

    # Standalone pass-rate on common universe.
    standalone = {}
    vectors = {}
    print(f"{'Config':<35} {'Pass':>5} {'Total':>6} {'Rate':>8}")
    print("-" * 56)
    for name, d in configs.items():
        vec = [1 if d[idx] else 0 for idx in common_idx]
        vectors[name] = vec
        passed = sum(vec)
        rate = 100 * passed / n_common
        standalone[name] = rate
        print(f"{name:<35} {passed:>5} {n_common:>6} {rate:>7.2f}%")

    # Pairwise correlation (phi coefficient) on common universe.
    names = sorted(configs.keys())
    print("\n=== Pairwise correlation (phi) ===")
    print(f"{'pair':<55} {'corr':>8} {'OR_2':>8}")
    print("-" * 73)
    pairs = []
    for a, b in combinations(names, 2):
        c = pearson(vectors[a], vectors[b])
        or_vec = [max(vectors[a][i], vectors[b][i]) for i in range(n_common)]
        or_rate = 100 * sum(or_vec) / n_common
        pairs.append((a, b, c, or_rate))
    pairs.sort(key=lambda r: r[2])
    for a, b, c, or_rate in pairs[:15]:
        print(f"{a:>26} ↔ {b:<26} {c:>7.3f} {or_rate:>7.2f}%")

    # 3-config combinations: only those with each config >= 40% standalone.
    eligible = [n for n in names if standalone[n] >= 40.0]
    print(f"\n=== Eligible configs (≥40% standalone): {len(eligible)} ===")
    for n in eligible:
        print(f"  {n}: {standalone[n]:.2f}%")

    print(f"\n=== Best 3-config OR-aggregations (≥40% each) ===")
    triples = []
    for a, b, c in combinations(eligible, 3):
        va, vb, vc = vectors[a], vectors[b], vectors[c]
        or_vec = [max(va[i], vb[i], vc[i]) for i in range(n_common)]
        or_rate = 100 * sum(or_vec) / n_common
        # Mean pairwise corr of the triple
        cab = pearson(va, vb)
        cac = pearson(va, vc)
        cbc = pearson(vb, vc)
        mean_corr = (cab + cac + cbc) / 3
        triples.append((a, b, c, or_rate, mean_corr, cab, cac, cbc))
    triples.sort(key=lambda r: -r[3])
    print(f"{'triple':<70} {'OR':>7} {'corr':>7}")
    print("-" * 86)
    for a, b, c, or_rate, mc, cab, cac, cbc in triples[:15]:
        names_str = f"{a[:18]}+{b[:18]}+{c[:18]}"
        print(f"{names_str:<70} {or_rate:>6.2f}% {mc:>7.3f}")

    if triples:
        a, b, c, or_rate, mc, cab, cac, cbc = triples[0]
        print("\n=== TOP-1 3-STACK RECOMMENDATION ===")
        print(f"  A: {a}  ({standalone[a]:.2f}%)")
        print(f"  B: {b}  ({standalone[b]:.2f}%)")
        print(f"  C: {c}  ({standalone[c]:.2f}%)")
        print(f"  Pairwise corr: A↔B={cab:.3f}, A↔C={cac:.3f}, B↔C={cbc:.3f}")
        print(f"  Mean corr: {mc:.3f}")
        print(f"  OR-aggregation (>=1 of 3 passes): {or_rate:.2f}%")

    # Lowest-corr triple among eligible
    triples_low = sorted(triples, key=lambda r: r[4])
    if triples_low:
        a, b, c, or_rate, mc, cab, cac, cbc = triples_low[0]
        print("\n=== LOWEST-CORRELATION 3-STACK ===")
        print(f"  A: {a}  ({standalone[a]:.2f}%)")
        print(f"  B: {b}  ({standalone[b]:.2f}%)")
        print(f"  C: {c}  ({standalone[c]:.2f}%)")
        print(f"  Pairwise corr: A↔B={cab:.3f}, A↔C={cac:.3f}, B↔C={cbc:.3f}")
        print(f"  Mean corr: {mc:.3f}")
        print(f"  OR-aggregation (>=1 of 3 passes): {or_rate:.2f}%")


if __name__ == "__main__":
    main()
