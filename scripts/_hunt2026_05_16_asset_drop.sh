#!/bin/bash
# 2026-05-16 Asset-Drop Hunt — test if reducing 19→N assets boosts Combined.
# Hypothesis: 24→19 drop showed -3pp = mid-cap pairs hurt. Maybe 19→11 helps too.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/hunt_2026_05_16
RESULTS="$OUT/asset_drop.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tassets_n\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BASE_CFG="2h-trend-v5-amber-max-passlock"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON_BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --windows 334 --step-days 3 --threads 14"

START_TS=$(date +%s)
COUNT=0
TOTAL=12

run() {
  local label="$1"; local syms="$2"
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"; return
  fi
  local n=$(echo "$syms" | tr ',' '\n' | wc -l)
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s n=${n}] $label"
  local p1=$($SWEEP $COMMON_BASE --symbols "$syms" --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON_BASE --symbols "$syms" --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$n\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# Asset sets — sorted by typical market cap
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
SYMS_15="ADAUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"
SYMS_12="AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"
SYMS_11="ADAUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,SOLUSDT,XRPUSDT"
SYMS_8="AVAXUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,SOLUSDT,XRPUSDT"
SYMS_6="AVAXUSDT,BNBUSDT,BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT"
SYMS_5="BNBUSDT,BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT"
SYMS_3="BTCUSDT,ETHUSDT,SOLUSDT"

# Drop variants
SYMS_no_ALGO="AAVEUSDT,ADAUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
SYMS_no_TRX="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"
SYMS_no_ETC="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
SYMS_no_AAVE_ALGO_TRX_ETC="ADAUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

run "A01_19_baseline"       "$SYMS_19"
run "A02_drop_ALGO"         "$SYMS_no_ALGO"
run "A03_drop_TRX"          "$SYMS_no_TRX"
run "A04_drop_ETC"          "$SYMS_no_ETC"
run "A05_15_quality"        "$SYMS_15"
run "A06_drop_4_smallcap"   "$SYMS_no_AAVE_ALGO_TRX_ETC"
run "A07_12_majors"         "$SYMS_12"
run "A08_11_top"            "$SYMS_11"
run "A09_8_majors"          "$SYMS_8"
run "A10_6_top"             "$SYMS_6"
run "A11_5_btc-eth-bnb-sol-xrp" "$SYMS_5"
run "A12_3_btc-eth-sol"     "$SYMS_3"

echo ""
echo "=== TOP 10 by Combined ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -11
