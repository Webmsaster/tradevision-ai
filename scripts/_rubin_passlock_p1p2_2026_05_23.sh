#!/bin/bash
# 2026-05-23 RUBIN_PASSLOCK P1 + P2 sweep to enable Stack-4 orthogonal measure.
# Stack-4 candidate: AMBER + BIDIR + MR + RUBIN (already 3-stack 51.96% measured,
# RUBIN adds different basket/tp params → may push to ~55-60%).
# RUBIN_PASSLOCK template exists (v5_rubin_passlock in templates.rs), BIDIR/MR
# baseline shows P2 sweeps are already there for AMBER+BIDIR+MR.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/stack4_rubin
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 4 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --config 2h-trend-v5-rubin-passlock"

echo "[run] RUBIN_PASSLOCK P1 (+10%/30d)"
$SWEEP $BASE --profit-target 0.10 --max-days 30 --out "$OUT/rubin_p1.jsonl" 2>&1 | tail -1

echo "[run] RUBIN_PASSLOCK P2 (+5%/60d)"
$SWEEP $BASE --profit-target 0.05 --max-days 60 --out "$OUT/rubin_p2.jsonl" 2>&1 | tail -1

echo ""
echo "=== Stack-4 TRUE-SEQUENTIAL combined-funded (n=common windows) ==="
python3 - <<'EOF'
import json,os
STACK4 = "scripts/cache_bakeoff/stack4_rubin"
STACK3 = "scripts/cache_bakeoff/stack3_bidir_mr"

def load(path):
    d={}
    for l in open(path):
        o=json.loads(l); d[o["win_idx"]]=(bool(o["passed"]), o.get("final_day"))
    return d

# Reuse 3-stack data + new RUBIN runs
configs = {
    "amber":   (f"{STACK3}/amber_p1.jsonl",  f"{STACK3}/amber_p2.jsonl"),
    "bidir":   (f"{STACK3}/bidir_p1.jsonl",  f"{STACK3}/bidir_p2.jsonl"),
    "mr":      (f"{STACK3}/mr_p1.jsonl",     f"{STACK3}/mr_p2.jsonl"),
    "rubin":   (f"{STACK4}/rubin_p1.jsonl",  f"{STACK4}/rubin_p2.jsonl"),
}

P1 = {k: load(v[0]) for k,v in configs.items() if os.path.exists(v[0])}
P2 = {k: load(v[1]) for k,v in configs.items() if os.path.exists(v[1])}

tags = list(P1.keys())
print(f"loaded P1 configs: {tags}")

def funded(t, i):
    if i not in P1[t]: return None
    pass1, D = P1[t][i]
    if not pass1: return False
    j = i+D
    if j not in P2[t]: return None
    return P2[t][j][0]

allk = set(P1[tags[0]])
for t in tags[1:]: allk &= set(P1[t])
keys = sorted(allk)
n=0; per={t:0 for t in tags}; stack=0; vec={t:[] for t in tags}
for i in keys:
    fs = {t: funded(t, i) for t in tags}
    if any(v is None for v in fs.values()): continue
    n += 1
    for t in tags:
        per[t] += 1 if fs[t] else 0
        vec[t].append(1 if fs[t] else 0)
    if any(fs[t] for t in tags): stack += 1

print(f"\nevaluable windows: {n}\n")
print("=== Single-account TRUE-SEQUENTIAL combined-funded ===")
for t in tags:
    print(f"  {t:6s}  {per[t]}/{n} = {100*per[t]/n:.2f}%")
print(f"\n=== STACK-{len(tags)} min-1-funded (per-window OR) ===")
print(f"  {' + '.join(tags)} = {stack}/{n} = {100*stack/n:.2f}%")

def corr(a,b):
    na=len(a); ma=sum(a)/na; mb=sum(b)/na
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(na))
    da=(sum((x-ma)**2 for x in a))**0.5
    db=(sum((x-mb)**2 for x in b))**0.5
    return num/(da*db) if da>0 and db>0 else 0.0

print("\n=== Pairwise correlations ===")
for i,a in enumerate(tags):
    for b in tags[i+1:]:
        print(f"  {a:6s} <-> {b:6s}  corr = {corr(vec[a],vec[b]):+.3f}")

p=[per[t]/n for t in tags]
indep_or = 1
for x in p: indep_or *= (1-x)
indep_or = 1 - indep_or
print(f"\nindependence-bound OR: {100*indep_or:.2f}%   measured/bound: {(stack/n)/indep_or:.3f}")
EOF
