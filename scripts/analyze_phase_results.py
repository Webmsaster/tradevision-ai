#!/usr/bin/env python3
"""
2026-05-17 Phase results aggregator.
Reads all phase TSVs in hunt_2026_05_17/, prints a unified ranked summary.

Usage: python3 scripts/analyze_phase_results.py [pattern]
  pattern: glob filter (default *.tsv)
"""
import sys
from pathlib import Path

ROOT = Path("scripts/cache_bakeoff/hunt_2026_05_17")
pattern = sys.argv[1] if len(sys.argv) > 1 else "*.tsv"

print(f"=== Aggregated phase results (pattern: {pattern}) ===\n")

all_rows = []
for tsv in sorted(ROOT.glob(pattern)):
    name = tsv.stem
    lines = tsv.read_text().splitlines()
    if not lines or len(lines) < 2:
        continue
    header = lines[0].split("\t")
    rows = [l.split("\t") for l in lines[1:] if l.strip()]
    if not rows:
        continue
    # find Combined column
    combined_col = None
    for i, h in enumerate(header):
        if "combined" in h.lower():
            combined_col = i
            break
    if combined_col is None:
        continue
    for r in rows:
        try:
            c = float(r[combined_col])
            all_rows.append((c, name, r[0]))
        except (ValueError, IndexError):
            pass

all_rows.sort(reverse=True)

print(f"{'Combined':>10}  {'Phase':<30}  Label")
print("-" * 80)
for c, ph, lbl in all_rows[:30]:
    print(f"{c:>9.2f}%  {ph:<30}  {lbl}")
print()
print(f"Total measurements: {len(all_rows)}")
print(f"Max: {all_rows[0][0]:.2f}% ({all_rows[0][1]} / {all_rows[0][2]})" if all_rows else "no data")
