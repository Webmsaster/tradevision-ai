#!/bin/bash
# 2026-05-16 Variant Hunt — test all AMBER variants with post-bugfix engine
# (atrStop fix in passlock variants). Compare against current champion.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
SYMS_15="AAVEUSDT,ADAUSDT,ARBUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,SOLUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
RESULTS="$OUT/variants_postfix.tsv"
: > "$RESULTS"
echo -e "label\tassets_n\tP1\tP2\tcombined_pct" >> "$RESULTS"

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --windows 334 --step-days 3 --threads 14"

run() {
  local label="$1"; local cfg="$2"; local syms="$3"; shift 3
  local n=$(echo "$syms" | tr ',' '\n' | wc -l)
  local p1=$($SWEEP $COMMON --symbols "$syms" --config "$cfg" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --symbols "$syms" --config "$cfg" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$n\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

run "V01_amber_max_pl"          "2h-trend-v5-amber-max-passlock"      "$SYMS_19"
run "V02_amber_ext_pl"          "2h-trend-v5-amber-ext-passlock"      "$SYMS_19"
run "V03_amber_pl"              "2h-trend-v5-amber-passlock"          "$SYMS_15"
run "V04_amber_pl_mptp"         "2h-trend-v5-amber-passlock-mptp"     "$SYMS_15"
run "V05_amber_pl_daystage"     "2h-trend-v5-amber-passlock-daystage" "$SYMS_15"
run "V06_amber_quartz_pl"       "2h-trend-v5-amber-quartz-passlock"   "$SYMS_15"
run "V07_amber_be_pl"           "2h-trend-v5-amber-be-passlock"       "$SYMS_15"
run "V08_amber_atr_pl"          "2h-trend-v5-amber-atr-passlock"      "$SYMS_15"

echo ""
echo "=== TOP variants (post-bugfix engine) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -10
