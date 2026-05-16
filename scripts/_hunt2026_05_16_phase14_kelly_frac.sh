#!/bin/bash
# 2026-05-16 Phase 14 — Kelly-Fractional + Stacking (Hunt 17a brainstorm).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase14_kelly_frac.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
CHAMP="--override-tp-mult 1.14 --kelly-sizing --kelly-window 100 --kelly-min-trades 30 --max-days 45"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Fractional-Kelly sweep on champion
run "F00_champion_full_kelly"
run "F01_kelly_frac_0.25"   --kelly-fraction 0.25
run "F02_kelly_frac_0.50"   --kelly-fraction 0.50
run "F03_kelly_frac_0.65"   --kelly-fraction 0.65
run "F04_kelly_frac_0.75"   --kelly-fraction 0.75
run "F05_kelly_frac_0.85"   --kelly-fraction 0.85
run "F06_kelly_frac_0.95"   --kelly-fraction 0.95

# Half-Kelly + variations
run "F07_frac_0.5_w60"       --kelly-fraction 0.50 --kelly-window 60 --kelly-min-trades 20
run "F08_frac_0.5_w150"      --kelly-fraction 0.50 --kelly-window 150 --kelly-min-trades 50

echo ""
echo "=== Phase 14 Kelly-Frac results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -12
