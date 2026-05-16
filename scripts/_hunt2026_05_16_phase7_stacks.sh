#!/bin/bash
# 2026-05-16 Phase 7 — Stack winners from Phase 1+5: Kelly w100/min30 + ad_line.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase7_stacks.tsv"
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

# T00 baseline
run "T00_baseline"

# T01 ad_line only (re-verify Phase 5)
run "T01_ad_line"           --regime-use-ad-line

# T02 kelly w100/min30 only (re-verify Phase 1)
run "T02_kelly_w100_min30"  --kelly-sizing --kelly-window 100 --kelly-min-trades 30

# T03 STACK: kelly + ad_line (key test)
run "T03_kelly_plus_adline" --kelly-sizing --kelly-window 100 --kelly-min-trades 30 --regime-use-ad-line

# T04 STACK: ad_line + nupl (both were 33.85/33.69)
run "T04_adline_plus_nupl"  --regime-use-ad-line --regime-use-nupl

# T05 TRIPLE STACK: kelly + ad_line + cmf (all "flat-or-positive" levers)
run "T05_kelly_adline_cmf"  --kelly-sizing --kelly-window 100 --kelly-min-trades 30 --regime-use-ad-line --regime-use-cmf

# T06 kelly with tighter window
run "T06_kelly_w200_min50"  --kelly-sizing --kelly-window 200 --kelly-min-trades 50

# T07 ad_line with kelly + variations
run "T07_kelly_w80_adline"  --kelly-sizing --kelly-window 80 --kelly-min-trades 25 --regime-use-ad-line

# T08 ad_line + double_top (flat in P5)
run "T08_adline_double_top" --regime-use-ad-line --regime-use-double-top

# T09 all "non-hurting" voters added
run "T09_full_stack"        --kelly-sizing --kelly-window 100 --kelly-min-trades 30 --regime-use-ad-line --regime-use-cmf --regime-use-nupl

echo ""
echo "=== Phase 7 Stack results ==="
sort -t$'\t' -k4 -rn "$RESULTS"
