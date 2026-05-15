#!/bin/bash
# 2026-05-15 Hunt Wave 4 — Phase 1 (pt=0.10) deep tuning at the champion base.
# P1 baseline 49.0%. Hardest target — large move means major Funded-prob uplift.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/wave4_p1_results.tsv"
: > "$RESULTS"
echo -e "label\tP1_pct" >> "$RESULTS"

BASE="2h-trend-v5-amber-max-passlock"
VOTERS="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --config $BASE --windows 1000 --step-days 1 --threads 8 --profit-target 0.10"

run() {
  local label="$1"
  shift
  local p1=$($SWEEP $COMMON $VOTERS "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ]; then echo "[skip] $label"; return; fi
  echo -e "$label\t$p1" | tee -a "$RESULTS"
}

run "BASELINE"

# tp_mult sweep — P1 needs LARGER tps because 10% target needs more juice per trade
for tp in 0.80 0.90 1.00 1.10 1.20 1.30 1.50; do
  run "tp=$tp" --override-tp-mult $tp
done

# Combo: larger tp + drop
for tp in 1.00 1.20 1.50; do
  for drop in "" "DOGEUSDT" "DOGEUSDT,RUNEUSDT"; do
    if [ -z "$drop" ]; then
      run "tp=${tp}_nodrop" --override-tp-mult $tp
    else
      run "tp=${tp}_drop=$drop" --override-tp-mult $tp --drop-symbols "$drop"
    fi
  done
done

# Aggressive sizing — larger leverage / risk
for lev in 1.5 2.0 3.0; do
  run "lev=$lev" --override-leverage $lev
done

# Stop-loss widening (give trades more room)
for sl in 0.03 0.04 0.05 0.06; do
  run "stop=$sl" --override-stop-pct $sl
done

# Extended hold (more time to reach 10%)
for hb in 12 24 48; do
  run "hold=$hb" --override-hold-bars $hb
done

# Time-decay sizing (size up early, down late — push to hit target faster)
run "td-default" --td-enable
run "td-aggressive" --td-enable --td-aggressive-factor 1.3 --td-decay 0.95

# Cross-asset filter (BTC trend confirmation)
run "xa-BTC-up" --cross-asset-sym BTCUSDT --cross-asset-dir up --cross-asset-fast 20 --cross-asset-slow 50

# Adaptive-tp (per-asset tight on BTC/ETH which dominate volume)
run "adapt-BTC-tight" --adaptive-tp "BTC-TREND:0.025"
run "adapt-BTC+ETH-tight" --adaptive-tp "BTC-TREND:0.025,ETH-TREND:0.025"

# MCT relaxed (more concurrent positions)
for m in 5 7 10 15; do
  run "mct=$m" --override-mct $m
done

# BE threshold tight (lock profits early so we don't give back)
for be in 0.005 0.010 0.015; do
  run "be=$be" --be-threshold $be
done

# Sharpe sizing
run "sharpe" --sharpe-window 60 --sharpe-min-trades 5

echo ""
echo "=== Wave 4 P1 TOP 15 ==="
sort -t$'\t' -k2 -rn "$RESULTS" | head -16
