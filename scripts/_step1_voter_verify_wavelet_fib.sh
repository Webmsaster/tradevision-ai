#!/bin/bash
# 2026-05-20: Verify Round-2 wavelet+fib claim at step=1d/n=1019.
# Baseline V00_sanity.jsonl already exists: 533/1019 = 52.31%.
# This script runs the 3 additions only.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_voters
RESULTS="$OUT/results_verify.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tpct\tpass\ttotal" >> "$RESULTS"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 2 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

V5="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"

run() {
  local label="$1"; shift
  local outfile="$OUT/${label}.jsonl"
  echo "[run] $label" >&2
  $SWEEP $COMMON "$@" --out "$outfile" > "$OUT/${label}.stdout" 2>&1 || true
  python3 -c "
import json
p=0; t=0
with open('$outfile') as f:
  for l in f:
    d=json.loads(l)
    t+=1
    if d.get('passed'): p+=1
pct = (p/t*100) if t else 0
print(f'$label\t{pct:.2f}\t{p}\t{t}')
" | tee -a "$RESULTS"
}

START_TS=$(date +%s)
run "V01_+wavelet"        $V5 --regime-use-wavelet
run "V02_+fib"            $V5 --regime-use-fib
run "V04_+wavelet+fib"    $V5 --regime-use-wavelet --regime-use-fib
ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== Verify complete in ${ELAPSED}s ==="
echo "V00_baseline	52.31	533	1019" >> "$RESULTS"
sort -t$'\t' -k2 -rn "$RESULTS" | column -t -s$'\t'
