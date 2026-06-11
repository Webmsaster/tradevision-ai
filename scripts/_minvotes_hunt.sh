#!/bin/bash
# 2026-05-19 — min-votes threshold sweep + voter-set variants
# Champion baseline: V5_AMBER_MAX_PASSLOCK tp=1.10 kf=0.5 ETH 10/30, 5 voters, mv=2 → 54.79%
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/minvotes_hunt
RESULTS="$OUT/results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tmin_votes\tvoters\tpassed\twindows\tpass_rate_pct" >> "$RESULTS"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 7 --threads 8"
ETH="--cross-asset-sym ETHUSDT --cross-asset-fast 10 --cross-asset-slow 30"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
TARGETS="--profit-target 0.10 --max-days 30 --signals regime --strict-pass"

V5_BASE="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
V4_NO_ADLINE="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
V6_WAV="$V5_BASE --regime-use-wavelet"
V6_FIB="$V5_BASE --regime-use-fib"
V6_ARI="$V5_BASE --regime-use-arima"
V5_NO_AD_WAV="$V4_NO_ADLINE --regime-use-wavelet"
V5_NO_AD_FIB="$V4_NO_ADLINE --regime-use-fib"
V5_NO_AD_ARI="$V4_NO_ADLINE --regime-use-arima"

run_sweep() {
  local label=$1; local mv=$2; local voter_desc=$3; shift 3
  local out_file="$OUT/${label}.jsonl"
  local raw=$("$SWEEP" $COMMON $TARGETS --regime-min-votes "$mv" "$@" $ETH $CHAMP --out "$out_file" 2>&1 | tail -3)
  # parse "passed=N / W (P%)"
  local stats=$(echo "$raw" | grep -oE 'passed=[0-9]+ / [0-9]+ \([0-9]+\.[0-9]+%\)' | tail -1)
  local passed=$(echo "$stats" | grep -oE 'passed=[0-9]+' | grep -oE '[0-9]+')
  local windows=$(echo "$stats" | grep -oE '/ [0-9]+ ' | grep -oE '[0-9]+')
  local rate=$(echo "$stats" | grep -oE '[0-9]+\.[0-9]+%' | tr -d '%')
  if [ -z "$rate" ]; then
    echo "[FAIL $label] $raw"
    rate="ERR"
    passed="ERR"
    windows="ERR"
  fi
  echo -e "$label\t$mv\t$voter_desc\t$passed\t$windows\t$rate" | tee -a "$RESULTS"
}

echo "=== Stage 1: min-votes sweep (5-voter set) ==="
run_sweep MV1  1 "poc+bb+st+hmm+ad" $V5_BASE
run_sweep MV2  2 "poc+bb+st+hmm+ad" $V5_BASE
run_sweep MV3  3 "poc+bb+st+hmm+ad" $V5_BASE
run_sweep MV4  4 "poc+bb+st+hmm+ad" $V5_BASE
run_sweep MV5  5 "poc+bb+st+hmm+ad" $V5_BASE

echo ""
echo "=== Stage 1 results sorted ==="
sort -t$'\t' -k6 -rn "$RESULTS" | head -6
BEST_MV=$(sort -t$'\t' -k6 -rn "$RESULTS" | head -1 | awk -F'\t' '{print $2}')
echo "Best min-votes: $BEST_MV"

echo ""
echo "=== Stage 2: voter-set variants at best min-votes=$BEST_MV ==="
# 4-voter (drop ad-line)
run_sweep "S2_4V_noAD_mv${BEST_MV}"  "$BEST_MV" "poc+bb+st+hmm"          $V4_NO_ADLINE
# 6-voter (add one)
run_sweep "S2_6V_wav_mv${BEST_MV}"   "$BEST_MV" "5V+wavelet"             $V6_WAV
run_sweep "S2_6V_fib_mv${BEST_MV}"   "$BEST_MV" "5V+fib"                 $V6_FIB
run_sweep "S2_6V_ari_mv${BEST_MV}"   "$BEST_MV" "5V+arima"               $V6_ARI
# 5-voter alternative (drop ad, swap in one)
run_sweep "S2_5V_noAD_wav_mv${BEST_MV}"  "$BEST_MV" "4V+wavelet"         $V5_NO_AD_WAV
run_sweep "S2_5V_noAD_fib_mv${BEST_MV}"  "$BEST_MV" "4V+fib"             $V5_NO_AD_FIB
run_sweep "S2_5V_noAD_ari_mv${BEST_MV}"  "$BEST_MV" "4V+arima"           $V5_NO_AD_ARI

# also test variants at mv-1 (looser) and mv+1 if reasonable
NEXT_MV=$((BEST_MV + 1))
if [ "$NEXT_MV" -le 5 ]; then
  run_sweep "S2_6V_wav_mv${NEXT_MV}"   "$NEXT_MV" "5V+wavelet"           $V6_WAV
  run_sweep "S2_6V_fib_mv${NEXT_MV}"   "$NEXT_MV" "5V+fib"               $V6_FIB
fi

echo ""
echo "=== Final results sorted by pass-rate desc ==="
sort -t$'\t' -k6 -rn "$RESULTS"
