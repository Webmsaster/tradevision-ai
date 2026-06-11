#!/bin/bash
# 2026-05-16 Phase 9 — Ultra-fine tp_mult around F12 winner 1.15
# + super-stacks (tp + kelly + adline + various extras).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase9_super.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"
ADLINE="--regime-use-ad-line"

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

# X00 baseline = F12 champion replication
run "X00_champion_F12"  --override-tp-mult 1.15 $KELLY $ADLINE

# Ultra-fine tp_mult around 1.15
run "X01_tp_1.12"        --override-tp-mult 1.12 $KELLY $ADLINE
run "X02_tp_1.13"        --override-tp-mult 1.13 $KELLY $ADLINE
run "X03_tp_1.14"        --override-tp-mult 1.14 $KELLY $ADLINE
run "X04_tp_1.16"        --override-tp-mult 1.16 $KELLY $ADLINE
run "X05_tp_1.17"        --override-tp-mult 1.17 $KELLY $ADLINE
run "X06_tp_1.18"        --override-tp-mult 1.18 $KELLY $ADLINE

# Add more flat-ish voters to champion
run "X07_F12+cmf"        --override-tp-mult 1.15 $KELLY $ADLINE --regime-use-cmf
run "X08_F12+nupl"       --override-tp-mult 1.15 $KELLY $ADLINE --regime-use-nupl
run "X09_F12+double_top" --override-tp-mult 1.15 $KELLY $ADLINE --regime-use-double-top

# Cross-asset filter variations on champion
run "X10_F12_ca_8_21"    --override-tp-mult 1.15 $KELLY $ADLINE --cross-asset-fast 8 --cross-asset-slow 21
run "X11_F12_ca_10_21"   --override-tp-mult 1.15 $KELLY $ADLINE --cross-asset-fast 10 --cross-asset-slow 21
run "X12_F12_ca_9_18"    --override-tp-mult 1.15 $KELLY $ADLINE --cross-asset-fast 9 --cross-asset-slow 18
run "X13_F12_ca_9_25"    --override-tp-mult 1.15 $KELLY $ADLINE --cross-asset-fast 9 --cross-asset-slow 25
run "X14_F12_ca_12_24"   --override-tp-mult 1.15 $KELLY $ADLINE --cross-asset-fast 12 --cross-asset-slow 24

# Kelly variations on champion
run "X15_F12_kelly_w120" --override-tp-mult 1.15 --kelly-sizing --kelly-window 120 --kelly-min-trades 40 $ADLINE
run "X16_F12_kelly_w80"  --override-tp-mult 1.15 --kelly-sizing --kelly-window 80 --kelly-min-trades 20 $ADLINE
run "X17_F12_kelly_w150" --override-tp-mult 1.15 --kelly-sizing --kelly-window 150 --kelly-min-trades 50 $ADLINE

# Try min_votes 3 on champion
run "X18_F12_min_votes3" --override-tp-mult 1.15 $KELLY $ADLINE --regime-min-votes 3

# Try stop_pct relaxation with high tp_mult (now larger tp needs larger stop)
run "X19_F12_stop_0.06"  --override-tp-mult 1.15 $KELLY $ADLINE --override-stop-pct 0.06

echo ""
echo "=== Phase 9 Super-Stack results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
