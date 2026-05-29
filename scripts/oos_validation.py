#!/usr/bin/env python3
"""
Out-of-sample (OOS) validation for the FTMO stack — the test the project never had.

Answers: "is the in-sample ~25% stack-4 baseline real, or selection-overfit?"
Method: select the best greedy stack-4 on the EARLY ~70% of windows (train), then
measure that same stack on the held-out LATE ~30% (test, never used for selection).
If test ≈ train → the baseline is robust. If test << train → it was overfit.

First run the sweeps (FTMO, close-based, step=2, full windows) into OUT_DIR:

  SWEEP=engine-rust/target/release/ftmo-sweep ; C=scripts/cache_bakeoff ; O=/tmp/oos
  for cfg in diamond:2h-trend-v5-diamond-passlock \
             sharpe:2h-trend-v5-amber-max-passlock-sharpe-tight \
             obsidian:2h-trend-v5-obsidian-passlock rubin:2h-trend-v5-rubin-passlock \
             ambermax:2h-trend-v5-amber-max-passlock bidir:2h-trend-v5-amber-max-passlock-bidir-safe; do
   ck=${cfg%%:*}; sel=${cfg#*:}
   for bk in l1beta:AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT \
             alt5:AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT \
             defi4:AAVEUSDT,LINKUSDT,UNIUSDT,ETHUSDT; do
     bkk=${bk%%:*}; sy=${bk#*:}
     for ph in p1:0.10:30 p2:0.05:60; do IFS=: read p t md <<<"$ph"
       "$SWEEP" --candles-dir $C --funding-dir $C --symbols $sy --windows 9999 --step-days 2 \
         --threads 1 --signals regime --config $sel --strict-pass --profit-target $t --max-days $md \
         --out $O/${ck}__${bkk}__${p}.jsonl & while [ $(jobs -rp|wc -l) -ge 4 ]; do wait -n; done
     done; done; done; wait

Then: python3 scripts/oos_validation.py [OUT_DIR] [train_frac]

NOTE: this validates the SELECTION step (which configs), not config DESIGN — the
templates/TP values were evolved on full history project-wide. A complete OOS would
re-run the GA/hunter on train-only. Selection-OOS holding (as of 2026-05-29:
train 23.9% -> test 25.2%) is still strong evidence the baseline is not an illusion.
"""
from __future__ import annotations
import json, math, sys, statistics as st
from pathlib import Path

CFGS = ["diamond", "sharpe", "obsidian", "rubin", "ambermax", "bidir"]
BASK = ["l1beta", "alt5", "defi4"]
STEP, GAP = 2, 1


def load(p: Path) -> dict[int, tuple[bool, int]]:
    d = {}
    for line in p.open():
        line = line.strip()
        if line:
            r = json.loads(line)
            d[int(r["win_idx"])] = (bool(r["passed"]), int(r.get("final_day") or 0))
    return d


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/oos")
    train_frac = float(sys.argv[2]) if len(sys.argv) > 2 else 0.70

    cands: dict[str, dict[int, bool]] = {}
    for c in CFGS:
        for b in BASK:
            lbl = f"{c}__{b}"
            p1, p2 = load(out / f"{lbl}__p1.jsonl"), load(out / f"{lbl}__p2.jsonl")
            fv = {}
            for i, (passed, fd) in p1.items():
                if not passed:
                    fv[i] = False
                    continue
                j = i + math.ceil((fd + GAP) / STEP)  # true-seq P2 start
                if j in p2:
                    fv[i] = p2[j][0]
            cands[lbl] = fv

    common = sorted(set.intersection(*(set(v) for v in cands.values())))
    lo, hi = common[0], common[-1]
    cut = lo + int(train_frac * (hi - lo))
    train = [i for i in common if i <= cut]
    test = [i for i in common if i > cut]

    def sor(labels, idxs):  # stack-OR funded rate over idxs
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

    print(f"windows: train={len(train)} (idx {train[0]}-{train[-1]}), test={len(test)} (idx {test[0]}-{test[-1]})")
    sel = greedy(train)
    print(f"\nSTACK-4 selected on TRAIN: {sel}")
    print(f"  TRAIN stack-OR : {sor(sel, train):.1%}")
    print(f"  TEST  stack-OR : {sor(sel, test):.1%}   <== honest out-of-sample")
    print(f"  TEST oracle    : {sor(greedy(test), test):.1%}  (best-on-test upper bound)")
    print(f"  overfit gap train->test: {sor(sel, train) - sor(sel, test):+.1%}")
    bs = max(cands, key=lambda l: single(l, train))
    print(f"\nSINGLE best-on-train: {bs}  train {single(bs, train):.1%} -> test {single(bs, test):.1%}")
    at = st.mean(single(l, train) for l in cands)
    ate = st.mean(single(l, test) for l in cands)
    print(f"avg single across all {len(cands)} candidates: train {at:.1%} -> test {ate:.1%} (gap {at - ate:+.1%})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
