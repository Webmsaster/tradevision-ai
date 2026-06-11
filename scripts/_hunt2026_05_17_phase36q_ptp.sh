#!/bin/bash
# 2026-05-17 Phase 36-Q — Partial-Take-Profit (PTP) levels grid.
# Champion uses AMBER_MAX_PASSLOCK which has `closeAllOnTargetReached` (lock
# all positions at +10%). But PTP closes parts of positions EARLIER. Test
# whether PTP improves P1 (the bottleneck phase).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase36q_ptp.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tptp_levels\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; local ptp="$2"
  echo "[$label ptp=$ptp]"
  local extra=""
  [ -n "$ptp" ] && extra="--ptp-levels $ptp"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP $extra 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP $extra 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && { echo "[skip-empty] $label"; return; }
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$ptp\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

run "P00_baseline_no_ptp"            ""
run "P01_lock_early_aggressive"      "0.02:0.30,0.04:0.30,0.06:0.40"
run "P02_lock_50_at_5pct"            "0.05:0.50"
run "P03_lock_50_at_7pct"            "0.07:0.50"
run "P04_three_tier_balanced"        "0.03:0.25,0.05:0.25,0.07:0.50"
run "P05_lock_third_at_4pct"         "0.04:0.33"
run "P06_late_lock_25"               "0.08:0.25"
run "P07_secure_at_9pct"             "0.09:0.50"

echo ""
echo "=== Phase 36-Q PTP grid (sorted by Combined desc) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head
