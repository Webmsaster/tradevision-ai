#!/bin/bash
# 2026-05-19 Step=1 honest re-validation of voter additions.
# Champion baseline: Basket-18 + BNB 18/50 + tp=1.10 + Kelly 0.5
# + 5 voters (poc-z, bb-z-mr, supertrend, hmm, ad-line).
# Round 2 had claimed +wavelet+fib = +4.79pp on step=7 (n=147 windows).
# Round 3 said that was redundant with ETH cross-asset (same 7 windows).
# This re-tests on step=1 (n=1019 windows) — true honest measurement.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_voters
RESULTS="$OUT/results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tpct\tpass\ttotal" >> "$RESULTS"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

# Voter sets
V5="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
V4_no_adline="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
V4_no_hmm="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-ad-line"
V4_no_pocz="--regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"

run() {
  local label="$1"; shift
  local outfile="$OUT/${label}.jsonl"
  echo ""
  echo "[run] $label"
  local raw=$($SWEEP $COMMON "$@" --out "$outfile" 2>&1 | tail -5)
  echo "$raw" | tail -3
  local pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  local pass_total=$(echo "$raw" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  local pass=$(echo "$pass_total" | cut -d/ -f1)
  local total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

# Baseline (5 voters)
run "V00_baseline_5v"            $V5

# Additions to 5-voter baseline
run "V01_+wavelet"               $V5 --regime-use-wavelet
run "V02_+fib"                   $V5 --regime-use-fib
run "V03_+arima"                 $V5 --regime-use-arima
run "V04_+wavelet+fib"           $V5 --regime-use-wavelet --regime-use-fib
run "V05_+wavelet+fib+arima"     $V5 --regime-use-wavelet --regime-use-fib --regime-use-arima

# Drop-one sets (4 voters)
run "V06_4v_no_adline"           $V4_no_adline
run "V07_4v_no_hmm"              $V4_no_hmm
run "V08_4v_no_pocz"             $V4_no_pocz

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== step=1 voter re-validation complete in ${ELAPSED}s ==="
echo ""
sort -t$'\t' -k2 -rn "$RESULTS" | column -t -s$'\t'
