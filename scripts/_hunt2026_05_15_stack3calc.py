#!/usr/bin/env python3
"""Pick best 3-stack from hunt results, maximizing combined Funded min-1-pass.

Inputs: scripts/cache_bakeoff/hunt_2026_05_15/*.tsv
Outputs: scripts/cache_bakeoff/hunt_2026_05_15/stack3_picks.txt
"""

from __future__ import annotations
import csv
import itertools
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Cand:
    label: str
    p1: float  # %
    p2: float  # %

    @property
    def funded(self) -> float:
        return self.p1 * self.p2 / 100  # %


def load_tsv(path: Path) -> list[Cand]:
    rows: list[Cand] = []
    if not path.exists():
        return rows
    with path.open() as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            try:
                p1 = float(row.get("P1", "0") or 0)
                p2 = float(row.get("P2", "0") or 0)
            except ValueError:
                continue
            if p1 <= 0 or p2 <= 0:
                continue
            label = row.get("config") or row.get("label") or "<no-label>"
            rows.append(Cand(label, p1, p2))
    return rows


def min1pass(cands: tuple[Cand, ...], phase: str) -> float:
    """min-1-pass probability for the given phase ('p1', 'p2', 'funded')."""
    prod_fail = 1.0
    for c in cands:
        if phase == "p1":
            rate = c.p1 / 100
        elif phase == "p2":
            rate = c.p2 / 100
        else:  # 'funded'
            rate = c.funded / 100
        prod_fail *= 1 - rate
    return (1 - prod_fail) * 100


def main() -> int:
    root = Path(__file__).resolve().parent / "cache_bakeoff" / "hunt_2026_05_15"
    files = [
        root / "wave1_results.tsv",
        root / "wave2_results.tsv",
        root / "combined_results.tsv",
    ]
    all_cands: list[Cand] = []
    for p in files:
        all_cands.extend(load_tsv(p))

    if not all_cands:
        print("No candidates loaded — waves still running?", file=sys.stderr)
        return 1

    # Dedupe by label (keep first)
    seen: set[str] = set()
    unique: list[Cand] = []
    for c in all_cands:
        if c.label not in seen:
            unique.append(c)
            seen.add(c.label)

    print(f"Loaded {len(unique)} unique candidates")
    print()

    # Top single-account by combined Funded
    by_funded = sorted(unique, key=lambda c: c.funded, reverse=True)
    print("=== TOP 10 single-account (Combined Funded P1×P2) ===")
    for c in by_funded[:10]:
        print(f"  {c.funded:5.2f}%  P1={c.p1:5.2f}  P2={c.p2:5.2f}  {c.label}")
    print()

    # Best 3-stack by min-1-pass Funded
    top_n = min(20, len(unique))
    pool = by_funded[:top_n]
    best_stacks: list[tuple[float, tuple[Cand, ...]]] = []
    for combo in itertools.combinations(pool, 3):
        f = min1pass(combo, "funded")
        best_stacks.append((f, combo))
    best_stacks.sort(key=lambda x: x[0], reverse=True)

    print("=== TOP 5 3-stacks (min-1-pass Funded) ===")
    for funded, combo in best_stacks[:5]:
        p1 = min1pass(combo, "p1")
        p2 = min1pass(combo, "p2")
        print(f"  Funded={funded:5.2f}%  P1={p1:5.2f}%  P2={p2:5.2f}%")
        for c in combo:
            print(f"     {c.label}  ({c.funded:5.2f}%)")
        print()

    # Save best pick
    out = root / "stack3_picks.txt"
    with out.open("w") as f:
        f.write("# Best 3-stack picks 2026-05-15\n\n")
        for funded, combo in best_stacks[:3]:
            f.write(f"Funded={funded:.2f}%  P1={min1pass(combo,'p1'):.2f}%  P2={min1pass(combo,'p2'):.2f}%\n")
            for c in combo:
                f.write(f"  - {c.label}  ({c.funded:.2f}%)\n")
            f.write("\n")
    print(f"Saved picks to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
