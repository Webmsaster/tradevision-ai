#!/bin/bash
# 2026-05-19 Concurrent-Position Cap Sweep
# Tests whether limiting max-concurrent-positions improves pass-rate.
# Champion: Basket-18 + BNB 18/50 + tp=1.10 (from _universe_expand_2026_05_19.sh)
# Default MCT on v5_amber_max_passlock = 10 (inherited from v5_amber).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_concur_cap
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
echo -e "label\tmct\tpct\tpass\ttotal" >> "$RESULTS"

BASKET18="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Champion (step=1 like prior 95% conditional measurements)
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $BASKET18 \
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
  local label="$1"; local mct="$2"
  local outfile="$OUT/${label}.jsonl"
  local extra=""
  if [ "$mct" != "default" ]; then
    extra="--override-mct $mct"
  fi
  echo "[run] $label (MCT=$mct)"
  local raw
  raw=$($SWEEP $COMMON $extra --out "$outfile" 2>&1 | tail -3)
  echo "  $raw" | tr '\n' ' '; echo ""
  local pct pass_total pass total
  pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  pass_total=$(echo "$raw" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  pass=$(echo "$pass_total" | cut -d/ -f1)
  total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t$mct\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

run "M01_cap_1"          "1"
run "M02_cap_2"          "2"
run "M03_cap_3"          "3"
run "M05_cap_5"          "5"
run "M10_cap_10_default" "10"
run "M50_cap_50_unlim"   "50"

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== Concurrent-Cap Sweep complete in ${ELAPSED}s ==="
echo ""
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
