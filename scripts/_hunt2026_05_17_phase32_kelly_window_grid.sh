#!/bin/bash
# 2026-05-17 Phase 32 — Kelly window/min-trades Grid Sweep.
# Phase 25c gridded kelly_fraction + tp_mult and confirmed 1.14 / 0.50 plateau.
# But kelly_window and kelly_min_trades were not gridded. Memory champion uses
# w60/m20 (Phase 25) vs w100/m30 (Phase 16 goal_achieved). Try wider grid.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase32_kelly_grid.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tkw\tkm\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"

for kw in 30 40 60 80 100 150; do
  for km in 10 15 20 30 50; do
    label="kw${kw}_km${km}"
    CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window $kw --kelly-min-trades $km"
    echo "[$label]"
    p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    [ -z "$p1" ] || [ -z "$p2" ] && continue
    c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
    echo -e "$label\t$kw\t$km\t$p1\t$p2\t$c" | tee -a "$RESULTS"
  done
done

echo ""
echo "=== Phase 32 Kelly grid (sorted by Combined desc) ==="
sort -t$'\t' -k6 -rn "$RESULTS" | head -15
