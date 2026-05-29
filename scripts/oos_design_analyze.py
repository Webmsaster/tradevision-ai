#!/usr/bin/env python3
"""
Design-overfit OOS analysis. Reads the config×basket×KNOB sweep data produced by
oos_design_gen.sh, selects the best greedy stack-4 over the FULL tuned space on
the early ~70% (train), and measures it on the held-out late ~30% (test).

If the train-selected (knob-tuned) stack holds on test → the parameter DESIGN is
not overfit. If it craters → the in-sample knob tuning was overfit.

Usage: python3 scripts/oos_design_analyze.py [DIR] [train_frac]
"""
from __future__ import annotations
import json, math, sys, statistics as st
from pathlib import Path

STEP, GAP = 3, 1


def load(p: Path):
    d = {}
    for line in p.open():
        line = line.strip()
        if line:
            r = json.loads(line)
            d[int(r["win_idx"])] = (bool(r["passed"]), int(r.get("final_day") or 0))
    return d


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/oos_design")
    train_frac = float(sys.argv[2]) if len(sys.argv) > 2 else 0.70

    labels = sorted({p.name[: -len("__p1.jsonl")] for p in d.glob("*__p1.jsonl")})
    cands: dict[str, dict[int, bool]] = {}
    for lbl in labels:
        p1, p2 = load(d / f"{lbl}__p1.jsonl"), load(d / f"{lbl}__p2.jsonl")
        fv = {}
        for i, (passed, fd) in p1.items():
            if not passed:
                fv[i] = False
                continue
            j = i + math.ceil((fd + GAP) / STEP)
            if j in p2:
                fv[i] = p2[j][0]
        cands[lbl] = fv

    common = sorted(set.intersection(*(set(v) for v in cands.values())))
    lo, hi = common[0], common[-1]
    cut = lo + int(train_frac * (hi - lo))
    train = [i for i in common if i <= cut]
    test = [i for i in common if i > cut]

    def sor(labels, idxs):
        return (sum(1 for i in idxs if any(cands[l].get(i, False) for l in labels)) / len(idxs)) if idxs else 0.0

    def single(l, idxs):
        return (sum(1 for i in idxs if cands[l].get(i, False)) / len(idxs)) if idxs else 0.0

    def greedy(idxs, k=4):
        chosen, rem = [], list(cands)
        for _ in range(k):
            best = max(rem, key=lambda l: sor(chosen + [l], idxs))
            chosen.append(best)
            rem.remove(best)
        return chosen

    print(f"candidates: {len(cands)} (config×basket×knob)")
    print(f"windows: train={len(train)} (idx {train[0]}-{train[-1]}), test={len(test)} (idx {test[0]}-{test[-1]})\n")
    sel = greedy(train)
    print(f"STACK-4 selected on TRAIN (incl. tuned knobs): {sel}")
    print(f"  TRAIN stack-OR : {sor(sel, train):.1%}")
    print(f"  TEST  stack-OR : {sor(sel, test):.1%}   <== honest design-OOS")
    print(f"  TEST oracle    : {sor(greedy(test), test):.1%}  (best-on-test upper bound)")
    print(f"  overfit gap train->test: {sor(sel, train) - sor(sel, test):+.1%}")
    bs = max(cands, key=lambda l: single(l, train))
    print(f"\nSINGLE best-on-train: {bs}  train {single(bs, train):.1%} -> test {single(bs, test):.1%}")
    at = st.mean(single(l, train) for l in cands)
    ate = st.mean(single(l, test) for l in cands)
    print(f"avg single across {len(cands)} candidates: train {at:.1%} -> test {ate:.1%} (gap {at - ate:+.1%})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
