#!/bin/bash
# 2026-05-23 Orthogonal 3-Stack: AMBER + BIDIR + MR — TRUE-SEQUENTIAL combined-funded.
# Different from _stack3_funded_2026_05_22.sh (which used AMBER+RUBIN+TITANIUM).
# Cross-signal-class diversification: trend-long (AMBER) / long-short (BIDIR) /
# mean-revert (MR). Expected corr ~ 0 vs AMBER+RUBIN's corr=+0.48.
#
# P2 sweeps for BIDIR + MR already exist in scripts/cache_bakeoff/hunt_bidir_verify/.
# We need:
#   - BIDIR_P1, MR_P1 (run this script)
#   - AMBER P1+P2 from combined_p1p2/  (copy)
#   - BIDIR_P2, MR_P2 from hunt_bidir_verify/  (copy)
# Then compute true-sequential funded probability per config + per-window OR.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/stack3_bidir_mr
mkdir -p "$OUT"
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass"

run_p1() {
  local cfg="$1" tag="$2"
  echo "[run] $tag P1 (+10% / 30d)"
  $SWEEP $BASE --config "$cfg" --profit-target 0.10 --max-days 30 --out "$OUT/${tag}_p1.jsonl" 2>&1 | tail -1
}

# AMBER P1+P2 already in combined_p1p2/  →  reuse
cp scripts/cache_bakeoff/combined_p1p2/p1.jsonl "$OUT/amber_p1.jsonl"
cp scripts/cache_bakeoff/combined_p1p2/p2.jsonl "$OUT/amber_p2.jsonl"

# BIDIR P2, MR P2 already in hunt_bidir_verify/  →  reuse
cp scripts/cache_bakeoff/hunt_bidir_verify/bidir_p2.jsonl "$OUT/bidir_p2.jsonl"
cp scripts/cache_bakeoff/hunt_bidir_verify/mr_p2.jsonl    "$OUT/mr_p2.jsonl"

# Missing P1 sweeps:
run_p1 2h-trend-v5-amber-max-passlock-bidir bidir
run_p1 2h-trend-v5-amber-max-mr-passlock     mr

echo ""
python3 - "$OUT" <<'EOF'
import json,sys,os
OUT=sys.argv[1]
def load(tag,phase):
    d={}
    for l in open(os.path.join(OUT,f"{tag}_{phase}.jsonl")):
        o=json.loads(l); d[o["win_idx"]]=(bool(o["passed"]), o.get("final_day"))
    return d
tags=["amber","bidir","mr"]
P1={t:load(t,"p1") for t in tags}
P2={t:load(t,"p2") for t in tags}

def funded(t,i):
    # TRUE-SEQUENTIAL: P1 passes at i, then P2 starts at i+final_day(P1)
    if i not in P1[t]: return None
    p1_pass,D=P1[t][i]
    if not p1_pass: return False
    j=i+D
    if j not in P2[t]: return None
    p2_pass,_=P2[t][j]
    return p2_pass

# common evaluable window set (P1 known for all 3)
allk=set(P1[tags[0]])
for t in tags[1:]: allk &= set(P1[t])
keys=sorted(allk)
n=0; per={t:0 for t in tags}; stack=0; vec={t:[] for t in tags}
for i in keys:
    fs={t:funded(t,i) for t in tags}
    if any(v is None for v in fs.values()): continue
    n+=1
    for t in tags:
        per[t] += 1 if fs[t] else 0
        vec[t].append(1 if fs[t] else 0)
    if any(fs[t] for t in tags): stack+=1

print(f"evaluable windows: {n}\n")
print("=== Single-account TRUE-SEQUENTIAL combined-funded ===")
for t in tags:
    print(f"  {t:6s}  {per[t]}/{n} = {100*per[t]/n:.2f}%")
print(f"\n=== 3-STACK min-1-funded (per-window OR over orthogonal cross-class basket) ===")
print(f"  AMBER + BIDIR + MR  =  {stack}/{n} = {100*stack/n:.2f}%")

# pairwise correlations
import statistics as st
def corr(a,b):
    na=len(a); ma=sum(a)/na; mb=sum(b)/na
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(na))
    da=(sum((x-ma)**2 for x in a))**0.5
    db=(sum((x-mb)**2 for x in b))**0.5
    return num/(da*db) if da>0 and db>0 else 0.0
print("\n=== Pairwise correlations (binary funded vector) ===")
for i,a in enumerate(tags):
    for b in tags[i+1:]:
        print(f"  {a:6s} <-> {b:6s}  corr = {corr(vec[a],vec[b]):+.3f}")

# also report binomial floor (independence assumption)
import math
p=[per[t]/n for t in tags]
indep_or=1 - (1-p[0])*(1-p[1])*(1-p[2])
print(f"\n=== Sanity: independence-bound OR = {100*indep_or:.2f}% ===")
print(f"  measured / independence-bound  =  {stack/n/indep_or:+.3f}  (1.000 = perfect orthogonal)")
EOF
