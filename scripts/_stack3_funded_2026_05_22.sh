#!/bin/bash
# 2026-05-22 Honest 3-account stack combined-funded rate (sequential P1+P2 per
# account, then per-window OR = at least 1 of 3 accounts fully funded).
# Family-diverse stack: AMBER_MAX + RUBIN + TITANIUM (all PASSLOCK). Same base
# harness across all three (voters + BNB cross-asset + Kelly); orthogonality
# comes from the different templates. AMBER reuses combined_p1p2/ outputs.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/stack3
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

run_cfg() {
  local cfg="$1" tag="$2"
  echo "[run] $tag P1"; $SWEEP $BASE --config "$cfg" --profit-target 0.10 --max-days 30 --out "$OUT/${tag}_p1.jsonl" 2>&1 | tail -1
  echo "[run] $tag P2"; $SWEEP $BASE --config "$cfg" --profit-target 0.05 --max-days 60 --out "$OUT/${tag}_p2.jsonl" 2>&1 | tail -1
}

# AMBER already computed in combined_p1p2/ — symlink/copy for the joiner.
cp scripts/cache_bakeoff/combined_p1p2/p1.jsonl "$OUT/amber_p1.jsonl"
cp scripts/cache_bakeoff/combined_p1p2/p2.jsonl "$OUT/amber_p2.jsonl"
run_cfg 2h-trend-v5-rubin            rubin
run_cfg 2h-trend-v5-titanium-passlock titanium

echo ""
python3 - "$OUT" <<'EOF'
import json,sys,os
OUT=sys.argv[1]
def load(tag,phase):
    d={}
    for l in open(os.path.join(OUT,f"{tag}_{phase}.jsonl")):
        o=json.loads(l); d[o["win_idx"]]=(bool(o["passed"]), o.get("final_day"))
    return d
tags=["amber","rubin","titanium"]
P1={t:load(t,"p1") for t in tags}
P2={t:load(t,"p2") for t in tags}

def funded(t,i):
    # sequential: account funded iff P1 passes AND P2 at win i+final_day passes
    if i not in P1[t]: return None
    passed,D=P1[t][i]
    j=i+D
    if j not in P2[t]: return None
    return passed and P2[t][j]

# common window set across all accounts where the metric is evaluable
allk=set(P1["amber"])
for t in tags: allk &= set(P1[t])
keys=sorted(allk)
n=0; per={t:0 for t in tags}; stack=0
for i in keys:
    fs={t:funded(t,i) for t in tags}
    if any(v is None for v in fs.values()): continue
    n+=1
    for t in tags:
        if fs[t]: per[t]+=1
    if any(fs[t] for t in tags): stack+=1
print(f"evaluable windows: {n}")
for t in tags:
    print(f"  {t:9s} single-account funded: {per[t]}/{n} = {100*per[t]/n:.2f}%")
print(f">>> 3-STACK min-1-funded (>=1 of 3 accounts fully funded): {stack}/{n} = {100*stack/n:.2f}%")
EOF
