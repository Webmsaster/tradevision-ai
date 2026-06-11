#!/usr/bin/env python3
"""
2026-05-23 Stack-4 with TITANIUM_PASSLOCK as 4th member (vs RUBIN).

TITANIUM P1 corr with AMBER = -0.014 (near-zero! vs RUBIN +0.600).
Single P1 pass-rate: 41.95% (vs RUBIN 47.61%).

Trade-off: TITANIUM has LOWER single-rate but NEAR-ZERO correlation.
Question: does the orthogonality dominate the lower single rate?

Computes:
  - Single TRUE-SEQUENTIAL combined-funded per config (offset=0 AND offset=1)
  - Stack-4 OR with TITANIUM vs RUBIN
  - Pairwise corr matrix in both stack variants
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STACK3 = os.path.join(ROOT, "scripts/cache_bakeoff/stack3_bidir_mr")
STACK4_RUBIN = os.path.join(ROOT, "scripts/cache_bakeoff/stack4_rubin")
WAVE3 = os.path.join(ROOT, "scripts/cache_bakeoff/wave3_4thmember")


def load(path):
    d = {}
    for l in open(path):
        o = json.loads(l)
        d[o["win_idx"]] = (bool(o["passed"]), o.get("final_day"))
    return d


CONFIGS_RUBIN = {
    "amber":    (f"{STACK3}/amber_p1.jsonl",       f"{STACK3}/amber_p2.jsonl"),
    "bidir":    (f"{STACK3}/bidir_p1.jsonl",       f"{STACK3}/bidir_p2.jsonl"),
    "mr":       (f"{STACK3}/mr_p1.jsonl",          f"{STACK3}/mr_p2.jsonl"),
    "rubin":    (f"{STACK4_RUBIN}/rubin_p1.jsonl", f"{STACK4_RUBIN}/rubin_p2.jsonl"),
}

CONFIGS_TITANIUM = {
    "amber":    (f"{STACK3}/amber_p1.jsonl",         f"{STACK3}/amber_p2.jsonl"),
    "bidir":    (f"{STACK3}/bidir_p1.jsonl",         f"{STACK3}/bidir_p2.jsonl"),
    "mr":       (f"{STACK3}/mr_p1.jsonl",            f"{STACK3}/mr_p2.jsonl"),
    "titanium": (f"{WAVE3}/titanium_p1.jsonl",       f"{WAVE3}/titanium_p2.jsonl"),
}


def funded(P1, P2, tag, i, off):
    if i not in P1[tag]: return None
    p, D = P1[tag][i]
    if not p: return False
    j = i + D + off
    if j not in P2[tag]: return None
    return P2[tag][j][0]


def corr(a, b):
    na = len(a)
    if na == 0: return 0.0
    ma = sum(a)/na; mb = sum(b)/na
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(na))
    da = (sum((x-ma)**2 for x in a))**0.5
    db = (sum((x-mb)**2 for x in b))**0.5
    return num/(da*db) if da > 0 and db > 0 else 0.0


def analyze(configs, label, offset):
    P1 = {t: load(v[0]) for t, v in configs.items() if os.path.exists(v[0])}
    P2 = {t: load(v[1]) for t, v in configs.items() if os.path.exists(v[1])}
    if len(P1) != 4 or len(P2) != 4:
        print(f"\n=== {label} (offset={offset}) ===")
        print(f"  MISSING — P1 files: {list(P1)}, P2 files: {list(P2)}")
        return None

    tags = list(P1.keys())
    allk = set(P1[tags[0]])
    for t in tags[1:]: allk &= set(P1[t])
    keys = sorted(allk)

    per = {t: 0 for t in tags}
    n = 0; stack = 0
    vec = {t: [] for t in tags}
    for i in keys:
        fs = {t: funded(P1, P2, t, i, offset) for t in tags}
        if any(v is None for v in fs.values()): continue
        n += 1
        for t in tags:
            per[t] += 1 if fs[t] else 0
            vec[t].append(1 if fs[t] else 0)
        if any(fs[t] for t in tags): stack += 1

    print(f"\n=== {label} (offset={offset}) ===  n={n}")
    for t in tags:
        print(f"  {t:9s}  {per[t]}/{n} = {100*per[t]/n:.2f}%")
    print(f"  Stack-4 OR:  {stack}/{n} = {100*stack/n:.2f}%")
    print(f"  Pairwise corrs:")
    for i, a in enumerate(tags):
        for b in tags[i+1:]:
            print(f"    {a:9s} <-> {b:9s}  {corr(vec[a], vec[b]):+.3f}")
    return 100*stack/n


def main():
    print("="*70)
    print("Stack-4 comparison: RUBIN vs TITANIUM as 4th member")
    print("="*70)

    rubin_off0 = analyze(CONFIGS_RUBIN, "Stack-4 with RUBIN", offset=0)
    rubin_off1 = analyze(CONFIGS_RUBIN, "Stack-4 with RUBIN", offset=1)
    tit_off0 = analyze(CONFIGS_TITANIUM, "Stack-4 with TITANIUM", offset=0)
    tit_off1 = analyze(CONFIGS_TITANIUM, "Stack-4 with TITANIUM", offset=1)

    if tit_off0 is not None and rubin_off0 is not None:
        print("\n" + "="*70)
        print("VERDICT")
        print("="*70)
        print(f"Offset 0 (overlap):  RUBIN={rubin_off0:.2f}%  TITANIUM={tit_off0:.2f}%  Δ={tit_off0-rubin_off0:+.2f}pp")
        if rubin_off1 is not None and tit_off1 is not None:
            print(f"Offset 1 (honest):   RUBIN={rubin_off1:.2f}%  TITANIUM={tit_off1:.2f}%  Δ={tit_off1-rubin_off1:+.2f}pp")
        if tit_off0 > rubin_off0:
            print(f"\nTITANIUM WINS as 4th member — swap RUBIN → TITANIUM in orthogonal4stack PM2 config.")
        else:
            print(f"\nRUBIN holds — TITANIUM's lower single-rate doesn't overcome RUBIN's higher single rate.")


if __name__ == "__main__":
    main()
