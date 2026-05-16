#!/bin/bash
# 2026-05-16 Strategy-Brainstorm Quick-Test — top hypotheses from 10-agent
# brainstorm round. Test on AMBER_MAX_PASSLOCK + V02 voters + BTC-trend
# (33.69% honest baseline) with bug-frei lever combinations.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/brainstorm.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
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
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# ===== Funding-Rate Filter (agent #2 — historisch +2.21pp on R28_V6) =====
run "B01_baseline"           # baseline reference
run "B02_FRMILD"             --funding-max-long 0.001 --funding-min-short -0.0005
run "B03_FRMED"              --funding-max-long 0.0005 --funding-min-short -0.0003
run "B04_FRSTRICT"           --funding-max-long 0.0003 --funding-min-short -0.0002
run "B05_FRLONG_only"        --funding-max-long 0.0005

# ===== Time-of-Day Filter (agent #3) =====
run "B06_hours_EU_only"      --override-hours "8,10,12,14,16"
run "B07_hours_EU_US_dense"  --override-hours "8,10,12,14,16,18,20,22"
run "B08_hours_US_only"      --override-hours "14,16,18,20,22"

# ===== Day-of-Week Filter (agent #3) =====
run "B09_dow_Tue_Thu"        --override-dows "2,3,4"
run "B10_dow_Mo_Thu"         --override-dows "1,2,3,4"
run "B11_dow_Tue_Fri"        --override-dows "2,3,4,5"

# ===== Stacks (kombiniert beste hypotheses) =====
run "B12_FRMED_dow_TueThu"   --funding-max-long 0.0005 --funding-min-short -0.0003 --override-dows "2,3,4"
run "B13_FRMED_hours_EU_US"  --funding-max-long 0.0005 --funding-min-short -0.0003 --override-hours "8,10,12,14,16,18,20,22"
run "B14_FRMED_dow_TueFri"   --funding-max-long 0.0005 --funding-min-short -0.0003 --override-dows "2,3,4,5"

echo ""
echo "=== TOP 10 brainstorm tests ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -11
