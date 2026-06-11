#!/bin/bash
# 2026-05-17 Phase 25c — Champion Kelly-fraction grid.
# Tests fractions 0.30-0.80 in 0.10 steps. Memory says Half-Kelly (0.5)
# is current winner; this checks the plateau width.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase25c_kelly_grid.tsv"
: > "$RESULTS"
echo -e "kelly_frac\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14"

run() {
  local kf="$1"
  echo "[kelly_frac=$kf]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP --kelly-sizing --kelly-fraction "$kf" --kelly-window 60 --kelly-min-trades 20 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP --kelly-sizing --kelly-fraction "$kf" --kelly-window 60 --kelly-min-trades 20 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] kf=$kf"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$kf\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

for kf in 0.30 0.40 0.50 0.60 0.70 0.80; do
  run "$kf"
done

echo ""
echo "=== Phase 25c results (sorted by Combined desc) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head
