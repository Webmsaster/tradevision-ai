#!/usr/bin/env bash
# HMM threshold hunt: explore tighter p_bull/p_bear/p_opposite combos
set -euo pipefail

cd "$(dirname "$0")/.."

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT_DIR=scripts/cache_bakeoff/hmm_hunt
mkdir -p "$OUT_DIR"

run_one() {
  local label="$1"
  local p_bull="$2"
  local p_bear="$3"
  local p_opp="$4"
  local extra_args="${5:-}"
  local out="$OUT_DIR/${label}.jsonl"

  echo "=== Running $label (p_bull=$p_bull p_bear=$p_bear p_opp=$p_opp $extra_args) ==="

  # Build HMM flags (empty when label==no_hmm)
  local hmm_flags=""
  if [[ "$extra_args" == *"--no-hmm"* ]]; then
    # Drop HMM voter entirely
    hmm_flags=""
  else
    hmm_flags="--regime-use-hmm --hmm-p-bull $p_bull --hmm-p-bear $p_bear --hmm-p-opposite $p_opp"
  fi

  ./engine-rust/target/release/ftmo-sweep \
    --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
    --symbols "$SYMBOLS" --windows 334 --step-days 7 --threads 8 \
    --profit-target 0.10 --max-days 30 \
    --signals regime --regime-min-votes 2 \
    --regime-poc-z --regime-bb-z-mr --regime-use-supertrend \
    --regime-use-ad-line \
    $hmm_flags \
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 \
    --config 2h-trend-v5-amber-max-passlock \
    --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
    --kelly-window 60 --kelly-min-trades 20 \
    --strict-pass \
    --out "$out" 2>&1 | tail -5

  echo "Done: $label"
  echo ""
}

# Baseline: drop HMM voter entirely
run_one "baseline_no_hmm" 0 0 0 "--no-hmm"

# Default HMM (p_bull=0.55 p_bear=0.55 p_opp=0.20)
run_one "default_055_020" 0.55 0.55 0.20 ""

# Tighter p_bull/p_bear, default p_opp
run_one "tight_060_020" 0.60 0.60 0.20 ""
run_one "tight_065_020" 0.65 0.65 0.20 ""
run_one "tight_070_020" 0.70 0.70 0.20 ""
run_one "tight_075_020" 0.75 0.75 0.20 ""

# Tighter p_opposite (stricter exclusion)
run_one "tight_060_015" 0.60 0.60 0.15 ""
run_one "tight_065_015" 0.65 0.65 0.15 ""
run_one "tight_070_010" 0.70 0.70 0.10 ""
run_one "tight_075_010" 0.75 0.75 0.10 ""

# Looser variants
run_one "loose_050_025" 0.50 0.50 0.25 ""

echo "All HMM hunt runs complete."
ls -la "$OUT_DIR"/
