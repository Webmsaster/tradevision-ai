#!/usr/bin/env python3
"""Analyze step=1 sweep results for 4-Stack OR-aggregation."""
import json
import os
from collections import defaultdict

DIR = "/home/flooe/projects/tradevision-ai/scripts/cache_bakeoff/step1_4stack"
CONFIGS = ["AMBER_MAX", "RUBIN", "TITANIUM", "AMBER_MAX_MR"]


def load(name):
    """Return dict win_idx -> passed (bool)."""
    path = os.path.join(DIR, f"{name}.jsonl")
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            out[rec["win_idx"]] = bool(rec["passed"])
    return out


def main():
    data = {c: load(c) for c in CONFIGS}
    print("=" * 70)
    print("STEP=1 STANDALONE PASS-RATES")
    print("=" * 70)
    print(f"{'Config':<22} {'Windows':>8} {'Passed':>8} {'Pass%':>8}")
    print("-" * 70)
    standalone = {}
    for c in CONFIGS:
        d = data[c]
        n = len(d)
        passed = sum(1 for v in d.values() if v)
        pr = passed / n * 100 if n else 0.0
        standalone[c] = pr
        print(f"{c:<22} {n:>8} {passed:>8} {pr:>7.2f}%")

    # Common windows (intersection)
    common = set(data[CONFIGS[0]].keys())
    for c in CONFIGS[1:]:
        common &= set(data[c].keys())
    common = sorted(common)
    print()
    print(f"Common windows across all 4 configs: {len(common)}")

    # Pearson correlations on common windows
    print()
    print("=" * 70)
    print("PEARSON CORRELATIONS (on common windows, binary pass/fail)")
    print("=" * 70)
    import statistics

    def corr(a, b):
        n = len(a)
        if n == 0:
            return 0.0
        ma = sum(a) / n
        mb = sum(b) / n
        num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
        sa = sum((x - ma) ** 2 for x in a) ** 0.5
        sb = sum((x - mb) ** 2 for x in b) ** 0.5
        if sa == 0 or sb == 0:
            return 0.0
        return num / (sa * sb)

    vecs = {}
    for c in CONFIGS:
        vecs[c] = [1 if data[c][w] else 0 for w in common]
    print(f"{'':<22} " + " ".join(f"{c:>14}" for c in CONFIGS))
    for a in CONFIGS:
        row = [a.ljust(22)]
        for b in CONFIGS:
            row.append(f"{corr(vecs[a], vecs[b]):>14.4f}")
        print(" ".join(row))

    # Per-window pass rates for common windows (so apples-to-apples)
    print()
    print("=" * 70)
    print("STANDALONE PASS-RATES on COMMON windows (apples-to-apples)")
    print("=" * 70)
    common_pr = {}
    for c in CONFIGS:
        n = len(common)
        p = sum(vecs[c])
        common_pr[c] = p / n * 100
        print(f"{c:<22} {p}/{n} = {common_pr[c]:.2f}%")

    # Stacks on common windows
    print()
    print("=" * 70)
    print("OR-AGGREGATION STACKS (per-window: pass if ANY config passes)")
    print("=" * 70)

    # User-specified ordering: AMBER alone, AMBER+TITANIUM (lowest corr), AMBER+RUBIN+TITANIUM, all 4
    def stack_pass(configs, window_idx):
        return any(data[c][window_idx] for c in configs)

    def stack_pr(configs):
        n = len(common)
        p = sum(1 for w in common if stack_pass(configs, w))
        return p, n, p / n * 100

    stacks = [
        ("1-stack: AMBER_MAX", ["AMBER_MAX"]),
        ("2-stack: AMBER+TITANIUM", ["AMBER_MAX", "TITANIUM"]),
        ("3-stack: AMBER+RUBIN+TITANIUM", ["AMBER_MAX", "RUBIN", "TITANIUM"]),
        ("4-stack: ALL", CONFIGS),
    ]
    for name, cfgs in stacks:
        p, n, pr = stack_pr(cfgs)
        print(f"{name:<35} {p}/{n} = {pr:.2f}%")

    # Also: 2-stack AMBER+MR (lowest corr in some sweeps)
    print()
    print("(Bonus stacks — all 2-stack pairs)")
    for i, a in enumerate(CONFIGS):
        for b in CONFIGS[i + 1 :]:
            p, n, pr = stack_pr([a, b])
            print(f"  {a}+{b}: {pr:.2f}% (corr {corr(vecs[a], vecs[b]):.3f})")

    # Live realistic with -5pp drift
    print()
    print("=" * 70)
    print("LIVE-REALISTIC (with -5pp slippage drift)")
    print("=" * 70)
    for name, cfgs in stacks:
        p, n, pr = stack_pr(cfgs)
        live = max(0.0, pr - 5.0)
        print(f"{name:<35} backtest={pr:.2f}% → live≈{live:.2f}%")

    # Step=7 comparison
    print()
    print("=" * 70)
    print("STEP=7 vs STEP=1 COMPARISON")
    print("=" * 70)
    print("Step=7 (per Round 1+4 prior): 4-Stack OR = 84.93%")
    s4_p, s4_n, s4_pr = stack_pr(CONFIGS)
    print(f"Step=1 (this run, honest):     4-Stack OR = {s4_pr:.2f}%")
    print(f"Delta:                         {s4_pr - 84.93:+.2f}pp")


if __name__ == "__main__":
    main()
