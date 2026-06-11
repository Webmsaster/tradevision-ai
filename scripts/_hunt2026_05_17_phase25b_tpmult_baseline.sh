#!/bin/bash
# 2026-05-17 Phase 25b — Champion-baseline tp_mult robustness check.
# Runs in parallel to Phase 25 (uses 4 free threads, system has 16 cores).
# Tests whether champion (no extra voters) responds to tp_mult variations.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase25b_tpmult_baseline.tsv"
: > "$RESULTS"
echo -e "tp_mult\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local tpm="$1"
  echo "[tp_mult=$tpm]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP --override-tp-mult "$tpm" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP --override-tp-mult "$tpm" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] tp=$tpm"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$tpm\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

for tp in 1.06 1.08 1.10 1.12 1.14 1.16 1.18 1.20; do
  run "$tp"
done

echo ""
echo "=== Phase 25b results (sorted by Combined desc) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head
