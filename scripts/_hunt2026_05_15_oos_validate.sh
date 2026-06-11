#!/bin/bash
# 2026-05-15 OOS Validation — Walk-forward step=7 + strict-pass on top-K candidates.
# Called manually with: bash scripts/_hunt2026_05_15_oos_validate.sh "config args here"
# Expects ENV: CANDIDATE_LABEL, CANDIDATE_ARGS
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
RESULTS="$OUT/oos_validation.tsv"
[ -f "$RESULTS" ] || echo -e "label\tpt\tmode\tpct" > "$RESULTS"

LABEL="${CANDIDATE_LABEL:?need CANDIDATE_LABEL}"
ARGS="${CANDIDATE_ARGS:?need CANDIDATE_ARGS}"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 1000 --threads 8"

run_mode() {
  local mode_label="$1"
  local pt="$2"
  shift 2
  local pct=$($SWEEP $COMMON --profit-target $pt $ARGS "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  echo -e "$LABEL\t$pt\t$mode_label\t$pct" | tee -a "$RESULTS"
}

# Step=1 baseline (in-sample full)
run_mode "step1_p1"        0.10 --step-days 1
run_mode "step1_p2"        0.05 --step-days 1

# Step=7 walk-forward OOS (more independent windows)
run_mode "step7_p1"        0.10 --step-days 7
run_mode "step7_p2"        0.05 --step-days 7

# Strict-pass (engine give-back tail-pass disabled)
run_mode "step1_p1_strict" 0.10 --step-days 1 --strict-pass
run_mode "step1_p2_strict" 0.05 --step-days 1 --strict-pass

echo "=== $LABEL summary ==="
grep "^$LABEL" "$RESULTS" | tail -6
