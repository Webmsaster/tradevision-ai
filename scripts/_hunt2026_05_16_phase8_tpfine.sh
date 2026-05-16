#!/bin/bash
# 2026-05-16 Phase 8 — Feinsweep tp_mult around winner K03 = 1.1 (+1.61pp).
# Plus stack with Phase 1 Kelly + Phase 5 ad_line.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase8_tpfine.tsv"
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

# F00 baseline
run "F00_baseline"

# Feinsweep tp_mult 1.05 - 1.30
run "F01_tp_1.05" --override-tp-mult 1.05
run "F02_tp_1.10" --override-tp-mult 1.10
run "F03_tp_1.15" --override-tp-mult 1.15
run "F04_tp_1.20" --override-tp-mult 1.20
run "F05_tp_1.25" --override-tp-mult 1.25
run "F06_tp_1.30" --override-tp-mult 1.30
run "F07_tp_1.40" --override-tp-mult 1.40
run "F08_tp_1.50" --override-tp-mult 1.50

# STACKS with winners
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"
ADLINE="--regime-use-ad-line"

run "F09_tp_1.10+kelly"          --override-tp-mult 1.10 $KELLY
run "F10_tp_1.10+adline"         --override-tp-mult 1.10 $ADLINE
run "F11_tp_1.10+kelly+adline"   --override-tp-mult 1.10 $KELLY $ADLINE
run "F12_tp_1.15+kelly+adline"   --override-tp-mult 1.15 $KELLY $ADLINE

echo ""
echo "=== Phase 8 tp_mult Feinsweep results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
