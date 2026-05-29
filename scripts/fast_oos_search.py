#!/usr/bin/env python3
"""Fast OOS config search — funnel speed + built-in overfit protection.

Screens a config×basket×knob space cheaply (coarse step, P1-only, on TRAIN
windows only), promotes the survivors to a fine step, then reports
OUT-OF-SAMPLE: every candidate is SELECTED on the early ~70 % of windows
(train) and SCORED on the held-out late ~30 % (test) plus 3 chronological
folds. The headline number is ALWAYS the test number, and the train→test gap
is flagged — so a config that only looks good in-sample (the trap behind the
project's 9 champion debunks) is exposed instead of crowned.

Reuses the sweep catalog + jobs=12 parallel runner from fast_true_seq_screen.py.

Examples:
  # single-account pass-rate search over the clean configs × a few baskets:
  python3 scripts/fast_oos_search.py --configs diamond,obsidian,sharpe,rubin,ambermax \
      --baskets l1_beta,alt5_beta,defi4,maj6 --knobs base,votes1,tp105,tp115

  # small set, skip the L0 screen, go straight to fine-step OOS:
  python3 scripts/fast_oos_search.py --configs diamond,obsidian --baskets alt5_beta \
      --knobs base,votes1 --skip-l0
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import NamedTuple

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from fast_true_seq_screen import (  # noqa: E402  reuse the validated machinery
    PRESET_KNOBS,
    build_candidates,
    default_out_dir,
    load_jsonl,
    p2_start_idx,
    result_path,
    run_sweeps,
)


class Row(NamedTuple):
    label: str
    train: float
    test: float
    gap: float
    folds: tuple[float, ...]
    minf: float


def funded_vector(p1, p2, *, step_days, phase_gap_days):
    """{win_idx: funded_bool} — P1 passes then the joined P2 passes."""
    v = {}
    for idx in sorted(p1):
        row = p1[idx]
        if not row.passed:
            v[idx] = False
            continue
        j = p2_start_idx(idx, row.final_day, step_days=step_days, phase_gap_days=phase_gap_days)
        r = p2.get(j)
        if r is not None:
            v[idx] = r.passed
    return v


def split_indices(common, train_frac):
    lo, hi = common[0], common[-1]
    cut = lo + int(train_frac * (hi - lo))
    train = [i for i in common if i <= cut]
    test = [i for i in common if i > cut]
    n = len(common)
    folds = [common[: n // 3], common[n // 3 : 2 * n // 3], common[2 * n // 3 :]]
    return train, test, folds


def rate(vec, idxs):
    keys = [i for i in idxs if i in vec]
    return (sum(1 for i in keys if vec[i]) / len(keys)) if keys else 0.0


def greedy_stack(vectors, common, k=4):
    chosen, rem = [], list(vectors)
    def stack_rate(labels, idxs):
        return (sum(1 for i in idxs if any(vectors[l].get(i, False) for l in labels)) / len(idxs)) if idxs else 0.0
    for _ in range(min(k, len(rem))):
        best = max(rem, key=lambda l: stack_rate(chosen + [l], common))
        chosen.append(best)
        rem.remove(best)
    return chosen, stack_rate


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--configs", help="comma config keys (see fast_true_seq_screen CONFIGS)")
    ap.add_argument("--baskets", help="comma basket keys")
    ap.add_argument("--knobs", help="comma knob keys; else --preset")
    ap.add_argument("--preset", choices=sorted(PRESET_KNOBS), default="quick")
    ap.add_argument("--include-slow", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-shuffle", dest="shuffle", action="store_false", default=True)
    ap.add_argument("--max-candidates", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)        # safe: jobs×threads ≤ cores-2
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--objective", choices=("single", "stack"), default="single")
    ap.add_argument("--train-frac", type=float, default=0.70)
    ap.add_argument("--phase-gap-days", type=int, default=1)
    ap.add_argument("--overfit-gap", type=float, default=0.05, help="flag if train-test > this")
    # funnel
    ap.add_argument("--skip-l0", action="store_true")
    ap.add_argument("--l0-step-days", type=int, default=7)
    ap.add_argument("--l0-top", type=int, default=24, help="promote top-N by TRAIN P1-pass")
    ap.add_argument("--l1-step-days", type=int, default=2)
    ap.add_argument("--print-top", type=int, default=15)
    args = ap.parse_args()

    out = args.out_dir or default_out_dir()
    out.mkdir(parents=True, exist_ok=True)
    cands = build_candidates(args)
    if not cands:
        raise SystemExit("no candidates selected")
    print(f"[oos-search] {len(cands)} candidates → {out}  (jobs={args.jobs}, objective={args.objective})")

    # ---- L0: cheap P1-only screen, SELECT ON TRAIN ----
    if args.skip_l0:
        promoted = cands
    else:
        l0 = out / "l0"
        run_sweeps("l0", l0, cands, ("p1",), windows=9999, step_days=args.l0_step_days,
                   jobs=args.jobs, threads=args.threads, resume=True, dry_run=False, progress_every=25)
        p1s = {c.label: load_jsonl(result_path(l0, c, "p1")) for c in cands if result_path(l0, c, "p1").exists()}
        common0 = sorted(set.intersection(*(set(d) for d in p1s.values()))) if p1s else []
        tr0, _, _ = split_indices(common0, args.train_frac) if common0 else ([], [], [])
        def p1_train(c):
            d = p1s.get(c.label, {})
            keys = [i for i in tr0 if i in d]
            return (sum(1 for i in keys if d[i].passed) / len(keys)) if keys else 0.0
        ranked = sorted((c for c in cands if c.label in p1s), key=p1_train, reverse=True)
        promoted = ranked[: args.l0_top]
        print(f"[oos-search] L0 (step={args.l0_step_days}, P1-only, TRAIN-selected): "
              f"{len(promoted)}/{len(cands)} promoted (top P1-train {p1_train(promoted[0]):.1%})")

    # ---- L1: fine-step P1+P2 on survivors, full OOS ----
    l1 = out / "l1"
    run_sweeps("l1", l1, promoted, ("p1", "p2"), windows=9999, step_days=args.l1_step_days,
               jobs=args.jobs, threads=args.threads, resume=True, dry_run=False, progress_every=25)

    vectors = {}
    for c in promoted:
        p1p, p2p = result_path(l1, c, "p1"), result_path(l1, c, "p2")
        if not (p1p.exists() and p2p.exists()):
            continue
        vectors[c.label] = funded_vector(load_jsonl(p1p), load_jsonl(p2p),
                                          step_days=args.l1_step_days, phase_gap_days=args.phase_gap_days)
    if not vectors:
        raise SystemExit("no L1 results")
    common = sorted(set.intersection(*(set(v) for v in vectors.values())))
    train, test, folds = split_indices(common, args.train_frac)
    print(f"[oos-search] L1 (step={args.l1_step_days}): {len(vectors)} configs | "
          f"windows train={len(train)} test={len(test)} | OOS = select-on-train, score-on-test\n")

    if args.objective == "stack":
        sel, stack_rate = greedy_stack(vectors, train, k=4)
        print(f"GREEDY STACK-4 selected on TRAIN: {sel}")
        print(f"  TRAIN {stack_rate(sel, train):.1%} | TEST {stack_rate(sel, test):.1%} "
              f"| folds {'/'.join(f'{stack_rate(sel, f):.0%}' for f in folds)}")
        gap = stack_rate(sel, train) - stack_rate(sel, test)
        print(f"  overfit gap train→test: {gap:+.1%}  {'⚠️ OVERFIT' if gap > args.overfit_gap else 'OK'}")
        return 0

    # single-account leaderboard, SORTED BY TEST (held-out), with overfit flags.
    # A LARGE +gap (train≫test) = in-sample overfit; a large −gap (test≫train) =
    # test-period luck. min-fold is the robustness metric: a config that is good
    # in every chronological third is regime-robust, not lucky on one split.
    def build_row(label) -> Row:
        v = vectors[label]
        fr = tuple(rate(v, f) for f in folds)
        tr, te = rate(v, train), rate(v, test)
        return Row(label, tr, te, tr - te, fr, min(fr))

    rows = sorted((build_row(l) for l in vectors), key=lambda r: r.test, reverse=True)
    print(f"{'config__basket__knob':<40}{'TRAIN':>7}{'TEST':>7}{'gap':>7}{'minFold':>8}  flag")
    for r in rows[: args.print_top]:
        flag = "⚠️ OVERFIT" if r.gap > args.overfit_gap else ("✓ robust" if r.minf >= 0.08 else "")
        print(f"{r.label:<40}{r.train:>6.1%}{r.test:>7.1%}{r.gap:>+7.1%}{r.minf:>8.1%}  {flag}")
    # honest pick = the regime-robust config (best worst-fold) that is NOT
    # in-sample-overfit. Deliberately NOT the highest TEST (that can be luck).
    clean = [r for r in rows if r.gap <= args.overfit_gap]
    if clean:
        best = max(clean, key=lambda r: r.minf)
        print(f"\nHONEST PICK (non-overfit, best worst-fold): {best.label}")
        print(f"  test {best.test:.1%} | min-fold {best.minf:.1%} | gap {best.gap:+.1%}")
    print("\nNote: TEST + min-fold are the trustworthy numbers; ignore TRAIN-only highs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
