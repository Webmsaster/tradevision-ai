#!/usr/bin/env python3
"""
2026-05-17 Per-window AND scorer.
Reads two ftmo-sweep --out JSONLs (P1 and P2) and computes real per-window
AND pass-rate.

LEGACY METRIC WARNING:
This is NOT the accepted FTMO funded-probability metric anymore. It checks
P1 and P2 at the same win_idx, which does not model sequential evaluation.
For the accepted metric use:

  python3 scripts/true_seq_stack_audit.py label=p1.jsonl,p2.jsonl

Accepted metric:
  P1 at i passes -> P2 at i + final_day + phase_gap passes -> funded.

Usage:
  python3 scripts/per_window_and.py P1.jsonl P2.jsonl
"""
import json
import sys
from pathlib import Path

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        out[r["win_idx"]] = bool(r.get("passed", False))
    return out

def main():
    if len(sys.argv) < 3:
        print("usage: per_window_and.py P1.jsonl P2.jsonl [label]")
        sys.exit(1)
    p1_path, p2_path = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else "config"
    p1 = load(p1_path)
    p2 = load(p2_path)
    common = sorted(set(p1) & set(p2))
    n = len(common)
    if n == 0:
        print("no common windows")
        sys.exit(1)
    p1_only = sum(1 for k in common if p1[k] and not p2[k])
    p2_only = sum(1 for k in common if p2[k] and not p1[k])
    both = sum(1 for k in common if p1[k] and p2[k])
    neither = sum(1 for k in common if not p1[k] and not p2[k])
    p1_rate = sum(p1[k] for k in common) / n * 100
    p2_rate = sum(p2[k] for k in common) / n * 100
    and_rate = both / n * 100
    mult_rate = p1_rate * p2_rate / 100
    corr_proxy = (and_rate / p1_rate * 100) if p1_rate > 0 else 0
    print(f"== {label} (n={n}) ==")
    print(f"  P1 alone        : {p1_rate:6.2f}%")
    print(f"  P2 alone        : {p2_rate:6.2f}%")
    print(f"  P1*P2 mult      : {mult_rate:6.2f}%  (assumes independence)")
    print(f"  AND per-window  : {and_rate:6.2f}%  <-- LEGACY same-window metric")
    print("  accepted metric : use scripts/true_seq_stack_audit.py")
    print(f"  P(P2|P1)        : {corr_proxy:6.2f}%  (correlation proxy)")
    print(f"  pass-both       : {both}/{n}")
    print(f"  pass-P1-only    : {p1_only}/{n}")
    print(f"  pass-P2-only    : {p2_only}/{n}")
    print(f"  pass-neither    : {neither}/{n}")

if __name__ == "__main__":
    main()
