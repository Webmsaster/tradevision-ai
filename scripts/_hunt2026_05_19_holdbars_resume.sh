#!/bin/bash
# Resume hold_bars sweep for remaining values 48, 72, 96.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_holdbars
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"

SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

CHAMPION="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS \
  --windows 9999 --step-days 1 --threads 8 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend \
  --regime-use-hmm --regime-use-ad-line \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

run() {
  local hb="$1"
  local label="hb${hb}"
  local outfile="$OUT/${label}.jsonl"
  echo "[run] $label (hold_bars=$hb) start=$(date +%H:%M:%S)"
  local raw=$($SWEEP $CHAMPION --override-hold-bars "$hb" --out "$outfile" 2>&1 | tail -3)
  echo "  $raw" | tr '\n' ' '; echo ""
  local pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local pass_total=$(echo "$raw" | grep -oE 'passed=[0-9]+ / [0-9]+' | head -1 | grep -oE '[0-9]+ / [0-9]+' | tr -d ' ')
  local pass=$(echo "$pass_total" | cut -d/ -f1)
  local total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t$hb\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)
for HB in 48 72 96; do run "$HB"; done

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== hold_bars resume sweep complete in ${ELAPSED}s ==="
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
