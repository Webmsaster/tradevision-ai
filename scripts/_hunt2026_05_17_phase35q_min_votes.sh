#!/bin/bash
# 2026-05-17 Phase 35-Q — min-votes grid on Champion.
# Hypothesis: if all extra voters hurt, maybe min-votes itself is over-tuned.
# Memory champion uses min-votes 2. Try 1, 2, 3, 4 with current V02 voter set.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase35q_min_votes.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tmin_votes\tP1\tP2\tcombined_pct" >> "$RESULTS"

VOTERS="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

for mv in 1 2 3 4 5; do
  label="V_mv${mv}"
  echo "[$label min-votes=$mv]"
  p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 --signals regime --regime-min-votes $mv $VOTERS $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 --signals regime --regime-min-votes $mv $VOTERS $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && continue
  c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$mv\t$p1\t$p2\t$c" | tee -a "$RESULTS"
done

echo ""
echo "=== Phase 35-Q min-votes (sorted by Combined desc) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head
