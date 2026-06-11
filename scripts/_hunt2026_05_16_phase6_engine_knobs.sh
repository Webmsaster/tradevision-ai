#!/bin/bash
# 2026-05-16 Phase 6 — Engine-Knob Sensitivity Sweep on V02.
# Systematic vary on tp_mult, stop_pct, hold_bars, trail_activate, leverage.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase6_knobs.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# K00 baseline
run "K00_baseline"

# tp_mult sensitivity
run "K01_tp_mult_0.8"   --override-tp-mult 0.8
run "K02_tp_mult_0.9"   --override-tp-mult 0.9
run "K03_tp_mult_1.1"   --override-tp-mult 1.1
run "K04_tp_mult_1.2"   --override-tp-mult 1.2

# stop_pct sensitivity
run "K05_stop_0.03"     --override-stop-pct 0.03
run "K06_stop_0.04"     --override-stop-pct 0.04
run "K07_stop_0.06"     --override-stop-pct 0.06

# hold_bars sensitivity
run "K08_hold_240"      --override-hold-bars 240
run "K09_hold_360"      --override-hold-bars 360
run "K10_hold_480"      --override-hold-bars 480

# trail_activate sensitivity (for adaptive_tp trail)
run "K11_trail_act_0.01" --override-trail-activate 0.01
run "K12_trail_act_0.02" --override-trail-activate 0.02
run "K13_trail_act_0.03" --override-trail-activate 0.03

# leverage (riskFrac scaling)
run "K14_lev_0.8"        --override-leverage 0.8
run "K15_lev_1.2"        --override-leverage 1.2

# BE threshold
run "K16_be_0.005"       --be-threshold 0.005
run "K17_be_0.015"       --be-threshold 0.015

echo ""
echo "=== Phase 6 results (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
