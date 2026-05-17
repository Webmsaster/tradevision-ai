#!/bin/bash
# 2026-05-17 Phase 37-Q — Micro-grid around P06 PTP winner (0.08:0.25 = +0.71pp).
# Test trigger {7, 8, 9}% × close {15, 20, 25, 30, 35}%.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase37q_ptp_micro.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\ttrigger\tclose\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local trig="$1"; local cls="$2"
  local label="M_t${trig}_c${cls}"
  echo "[$label trig=$trig close=$cls]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP --ptp-levels "$trig:$cls" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP --ptp-levels "$trig:$cls" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && { echo "[skip-empty] $label"; return; }
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$trig\t$cls\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

for trig in 0.06 0.07 0.08 0.085 0.09; do
  for cls in 0.15 0.20 0.25 0.30 0.35; do
    run "$trig" "$cls"
  done
done

echo ""
echo "=== Phase 37-Q PTP micro-grid (sorted by Combined desc) ==="
sort -t$'\t' -k6 -rn "$RESULTS" | head -15
