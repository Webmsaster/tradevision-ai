#!/bin/bash
# 2026-05-15 Quick-grid — fast 500-window tp×vol grid at champion.
# Sacrifices precision for speed (47s/sweep instead of 95s).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/quickgrid_results.tsv"
: > "$RESULTS"
echo -e "label\tpt\tpass_pct" >> "$RESULTS"

BASE="2h-trend-v5-amber-max-passlock"
VOTERS="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
# Smaller window-count + threads=4 (lighter so doesn't drown Wave 1+2)
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --config $BASE --windows 500 --step-days 2 --threads 4"

run() {
  local label="$1"; local pt="$2"
  shift 2
  local pct=$($SWEEP $COMMON --profit-target $pt $VOTERS "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$pct" ]; then echo "[skip] $label"; return; fi
  echo -e "$label\t$pt\t$pct" | tee -a "$RESULTS"
}

# Phase 2 sweet-spot hunt: pt=0.05 × tp_mult grid
echo "### P2 tp_mult grid ###"
for tp in 0.55 0.65 0.75 0.85 0.95 1.05 1.20; do
  run "P2_tp=$tp" 0.05 --override-tp-mult $tp
done

# Phase 1 tp_mult grid
echo "### P1 tp_mult grid ###"
for tp in 0.80 1.00 1.20 1.40; do
  run "P1_tp=$tp" 0.10 --override-tp-mult $tp
done

# Drop combinations at pt=0.05 (P2 most promising)
echo "### P2 drop-symbols grid ###"
for drop in "DOGEUSDT" "RUNEUSDT" "INJUSDT" "DOGEUSDT,RUNEUSDT" "DOGEUSDT,RUNEUSDT,INJUSDT" "ALGOUSDT,TRXUSDT" "DOGEUSDT,RUNEUSDT,ALGOUSDT"; do
  run "P2_drop=$drop" 0.05 --drop-symbols "$drop"
done

echo ""
echo "=== Quickgrid TOP 15 ==="
sort -t$'\t' -k3 -rn "$RESULTS" | head -16
