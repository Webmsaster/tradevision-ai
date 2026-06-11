#!/bin/bash
# 2026-05-16 Phase 2.2 — POC-Zone Hard-Gate Hunt
# Test new --regime-poc-zone-gate flag with various HVN-thresholds.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/poc_zone.tsv"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"

START_TS=$(date +%s)
COUNT=0
TOTAL=7

run() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s] $label"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

run "Z00_baseline"
run "Z01_gate_ratio_1.3"      --regime-poc-zone-gate --poc-zone-hvn-min-ratio 1.3
run "Z02_gate_ratio_1.5"      --regime-poc-zone-gate --poc-zone-hvn-min-ratio 1.5
run "Z03_gate_ratio_2.0"      --regime-poc-zone-gate --poc-zone-hvn-min-ratio 2.0
run "Z04_gate_ratio_2.5"      --regime-poc-zone-gate --poc-zone-hvn-min-ratio 2.5
run "Z05_gate_ratio_3.0"      --regime-poc-zone-gate --poc-zone-hvn-min-ratio 3.0
run "Z06_gate_ratio_1.5_window96" --regime-poc-zone-gate --poc-zone-hvn-min-ratio 1.5 --regime-poc-period 96

echo ""
echo "=== TOP POC-Zone results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -8
