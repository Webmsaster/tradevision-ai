#!/bin/bash
# 2026-05-15 Hunt Wave 2 — voter-combinations + min-votes tuning at the champion base.
# Runs in parallel with Wave 1 (threads=8 each, 16 cores available).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/wave2_results.tsv"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

BASE="2h-trend-v5-amber-max-passlock"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --config $BASE --windows 1000 --step-days 1 --threads 8"

run_pair() {
  local label="$1"
  shift
  local p1=$($SWEEP $COMMON --profit-target 0.10 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then
    echo "[skip] $label"
    return
  fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# 5-voter champion baseline (sanity)
run_pair "5V_mv2_BASELINE" --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm

# 4-voter drops (remove one of 5)
run_pair "4V_no-HMM"        --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg
run_pair "4V_no-FVG"        --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm
run_pair "4V_no-SUPER"      --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-smc-fvg --regime-use-hmm
run_pair "4V_no-BBZ"        --signals regime --regime-min-votes 2 --regime-poc-z --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm
run_pair "4V_no-POCZ"       --signals regime --regime-min-votes 2 --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm

# 5-voter min-votes=3 (more conservative)
run_pair "5V_mv3" --signals regime --regime-min-votes 3 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm

# Add CMF, RSI, KAL, ADX, AROON to champion (6-voter sets)
run_pair "6V_mv2_+CMF"  --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-cmf
run_pair "6V_mv2_+RSI"  --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-rsi-hidden-div
run_pair "6V_mv2_+KAL"  --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-kalman-trend
run_pair "6V_mv2_+OFI"  --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-ofi
run_pair "6V_mv2_+ARO"  --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-aroon
run_pair "6V_mv2_+ADLINE" --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-ad-line
run_pair "6V_mv2_+DBLTOP" --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-double-top
run_pair "6V_mv2_+NUPL"   --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-nupl
run_pair "6V_mv2_+STBL"   --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-stablecoin

# 6-voter min-votes=3
run_pair "6V_mv3_+CMF"  --signals regime --regime-min-votes 3 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-cmf

# Vol-confirm with vol-mult tweak (champion uses vol-mult=2.0 by default)
run_pair "5V_mv2_volmult2.5" --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-vol-mult 2.5
run_pair "5V_mv2_volmult1.5" --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-vol-mult 1.5

# Strict-pass identity check (no soft tail-pass)
run_pair "5V_mv2_STRICT"     --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --strict-pass

echo ""
echo "=== Wave 2 TOP 10 by combined Funded ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -11
