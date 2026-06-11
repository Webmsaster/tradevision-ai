#!/bin/bash
# 2026-05-16 Voter-Combo + BTC-Trend Hunt — after L16 discovery, explore which
# additional macro-aware voters (AD-Line, NUPL, Stablecoin-Flow, Kalman, etc.)
# stack with BTC-trend filter. Same core voter set as V02_4V_no-FVG + BTC-trend.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/voters_btc.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

# V02 voter-set baseline (4 voters: POC-Z, BB-Z, Supertrend, HMM)
VOTERS_BASE="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BASE_CFG="2h-trend-v5-amber-max-passlock"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 14"

START_TS=$(date +%s)
COUNT=0
TOTAL=15

run() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"; return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s] $label"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# All variants use BTC_FILTER + base 4 voters, then ADD one additional voter

run "BV01_+kalman"        $VOTERS_BASE --regime-use-kalman-trend
run "BV02_+adline"        $VOTERS_BASE --regime-use-ad-line
run "BV03_+nupl"          $VOTERS_BASE --regime-use-nupl
run "BV04_+stablecoin"    $VOTERS_BASE --regime-use-stablecoin
run "BV05_+cmf"           $VOTERS_BASE --regime-use-cmf
run "BV06_+aroon"         $VOTERS_BASE --regime-use-aroon
run "BV07_+ofi"           $VOTERS_BASE --regime-use-ofi
run "BV08_+top-trader-ls" $VOTERS_BASE --regime-use-top-trader-ls
run "BV09_+cme-basis"     $VOTERS_BASE --regime-use-cme-basis
run "BV10_+cb-premium"    $VOTERS_BASE --regime-use-cb-premium

# Multi-voter stacks
run "BV11_+kal+stable"    $VOTERS_BASE --regime-use-kalman-trend --regime-use-stablecoin
run "BV12_+adline+kal"    $VOTERS_BASE --regime-use-ad-line --regime-use-kalman-trend
run "BV13_+nupl+kal"      $VOTERS_BASE --regime-use-nupl --regime-use-kalman-trend
run "BV14_mv3"            $VOTERS_BASE --regime-use-kalman-trend --regime-min-votes 3
run "BV15_min1"           $VOTERS_BASE --regime-min-votes 1

echo ""
echo "=== TOP 10 BTC-voter stacks ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -11
