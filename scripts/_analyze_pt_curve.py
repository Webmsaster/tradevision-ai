#!/usr/bin/env python3
"""2026-05-19 — Profit-target curve analysis at step=1 (honest).

Reads pt*.jsonl from scripts/cache_bakeoff/pt_curve_step1/, computes
honest pass-rate per pt, bootstrap CI, and compares to Round 3 step=7 numbers.
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "scripts/cache_bakeoff/pt_curve_step1"

# Round 3 step=7 reference numbers (from Round 3 Agent 10 profit-target curve)
# Source: project_session_2026_05_19_round2_singleaccount.md / Round 3 memory.
# These are step=7 single-account pass-rates from Round 3 Asset Optimizer's pt sweep:
STEP7_REF = {
    0.05: None,          # Step-2 pt=0.05 standalone = 60.27% (per memory)
    0.06: None,
    0.07: 54.79,         # The5ers Bootcamp +7% claim
    0.08: None,          # FTMO Normal (pre-2026-05-15)
    0.10: 50.00,         # FTMO P1 Standard
    0.12: None,
    0.15: None,
}

# Bootcamp / prop-firm reference (for the report)
PROP_FIRMS = {
    0.05: "FTMO Phase 2 / FundedNext +5%",
    0.06: "MyForexFunds +6%",
    0.07: "The5ers Bootcamp +7%",
    0.08: "Legacy FTMO Normal +8%",
    0.10: "FTMO P1 Standard +10%",
    0.12: "TopStep / FunderPro +12%",
    0.15: "MFF Aggressive / E8 +15%",
}


def load_jsonl(path: Path):
    """Return ordered list of (win_idx, passed_bool)."""
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            rows.append((d["win_idx"], bool(d["passed"])))
    return rows


def bootstrap_ci(passes, n_iter=10000, alpha=0.05, seed=42):
    """Bootstrap CI for proportion (passes is a list of 0/1)."""
    if not passes:
        return (0.0, 0.0)
    rng = random.Random(seed)
    n = len(passes)
    rates = []
    for _ in range(n_iter):
        sample = [passes[rng.randrange(n)] for _ in range(n)]
        rates.append(sum(sample) / n)
    rates.sort()
    lo = rates[int(n_iter * alpha / 2)]
    hi = rates[int(n_iter * (1 - alpha / 2))]
    return (lo * 100, hi * 100)


def main():
    pts = sorted(
        [float(p.stem.replace("pt", "")) / 100 for p in DIR.glob("pt*.jsonl") if p.stat().st_size > 0]
    )
    if not pts:
        print(f"No pt*.jsonl files found in {DIR}")
        sys.exit(1)

    print("=" * 100)
    print("PROFIT-TARGET CURVE — STEP=1 HONEST (Basket-18 + BNB 18/50 + tp=1.10 + Kelly 0.5)")
    print("=" * 100)
    print(f"{'pt':>5}  {'Prop firm':<35} {'pass':>6} {'tot':>5} {'rate':>7} {'95% CI':<18} {'step=7':>8} {'Δ':>7}")
    print("-" * 100)

    results = []
    for pt in pts:
        ptname = f"pt{int(pt*100):03d}"
        path = DIR / f"{ptname}.jsonl"
        rows = load_jsonl(path)
        if not rows:
            print(f"{pt:>5.2f}  EMPTY")
            continue
        passes = [int(r[1]) for r in rows]
        total = len(passes)
        n_pass = sum(passes)
        rate = 100 * n_pass / total
        lo, hi = bootstrap_ci(passes)
        ref = STEP7_REF.get(pt)
        ref_str = f"{ref:.2f}%" if ref is not None else "n/a"
        delta = f"{rate - ref:+.2f}pp" if ref is not None else "n/a"
        firm = PROP_FIRMS.get(pt, "—")
        ci_str = f"[{lo:.2f}, {hi:.2f}]"
        print(f"{pt:>5.2f}  {firm:<35} {n_pass:>6} {total:>5} {rate:>6.2f}% {ci_str:<18} {ref_str:>8} {delta:>7}")
        results.append((pt, firm, n_pass, total, rate, lo, hi))

    if not results:
        return

    # Best honest target
    best = max(results, key=lambda r: r[4])
    pt, firm, n_pass, total, rate, lo, hi = best
    print()
    print("=" * 100)
    print("BEST HONEST PROP-FIRM TARGET")
    print("=" * 100)
    print(f"  pt = {pt:.2f}  →  {firm}")
    print(f"  pass-rate: {n_pass}/{total} = {rate:.2f}%  (95% CI [{lo:.2f}, {hi:.2f}])")

    # Largest delta vs step=7
    deltas = []
    for pt, firm, n_pass, total, rate, lo, hi in results:
        ref = STEP7_REF.get(pt)
        if ref is not None:
            deltas.append((pt, ref, rate, rate - ref))
    if deltas:
        print()
        print("DELTA vs Round 3 STEP=7:")
        for pt, ref, rate, d in deltas:
            print(f"  pt={pt:.2f}: step=1 {rate:.2f}% vs step=7 {ref:.2f}%  ({d:+.2f}pp)")


if __name__ == "__main__":
    main()
