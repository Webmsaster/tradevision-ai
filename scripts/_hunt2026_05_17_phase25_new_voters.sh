#!/bin/bash
# 2026-05-17 Phase 25 — Test 10 NEW voters on champion
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
mkdir -p "$OUT"
RESULTS="$OUT/phase25_new_voters.tsv"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

run "N00_champion"
run "N01_+squeeze"        --regime-use-squeeze
run "N02_+hurst"          --regime-use-hurst
run "N03_+wavelet"        --regime-use-wavelet
run "N04_+pivot"          --regime-use-pivot
run "N05_+fib"            --regime-use-fib
run "N06_+vah_val"        --regime-use-vah-val
run "N07_+ichimoku"       --regime-use-ichimoku
run "N08_+arima"          --regime-use-arima
run "N09_+garch_gate"     --regime-use-garch-gate
run "N10_+bocpd_gate"     --regime-use-bocpd-gate
run "N11_+kama"           --regime-use-kama
run "N12_+fisher"         --regime-use-fisher
# Multi-voter combos
run "N13_+squeeze+hurst"  --regime-use-squeeze --regime-use-hurst
run "N14_+wavelet+ichi"   --regime-use-wavelet --regime-use-ichimoku
run "N15_+fib+vah"        --regime-use-fib --regime-use-vah-val
run "N16_+all_pure_price" --regime-use-squeeze --regime-use-hurst --regime-use-wavelet --regime-use-pivot --regime-use-fib --regime-use-vah-val --regime-use-ichimoku
run "N17_+gates"          --regime-use-garch-gate --regime-use-bocpd-gate

echo ""
echo "=== Phase 25 results (sorted by Combined) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -10
