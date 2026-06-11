#!/bin/bash
# 2026-05-16 Phase 5 — Neue Voter zur V02 baseline hinzufuegen.
# V02 baseline = regime + poc-z + bb-z-mr + supertrend + hmm (4 voters).
# Test alle 13 unused voters: einzeln addieren, danach Top-3 stacken.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase5_voters.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02_BASE="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02_BASE $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02_BASE $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# V00 baseline reference
run "V00_baseline_4voters"

# Pure-price voters (no external data)
run "V01_plus_aroon"          --regime-use-aroon
run "V02_plus_cmf"            --regime-use-cmf
run "V03_plus_double_top"     --regime-use-double-top
run "V04_plus_kalman_trend"   --regime-use-kalman-trend
run "V05_plus_ofi"            --regime-use-ofi
run "V06_plus_rsi_hidden_div" --regime-use-rsi-hidden-div
run "V07_plus_smc_fvg"        --regime-use-smc-fvg
run "V08_plus_ad_line"        --regime-use-ad-line
run "V09_plus_nupl"           --regime-use-nupl

# Min-votes increase test (require 3 of 5 instead of 2 of 4)
run "V10_min3_aroon_cmf"      --regime-use-aroon --regime-use-cmf --regime-min-votes 3
run "V11_min3_aroon_kalman"   --regime-use-aroon --regime-use-kalman-trend --regime-min-votes 3

echo ""
echo "=== Phase 5 Voter results (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
