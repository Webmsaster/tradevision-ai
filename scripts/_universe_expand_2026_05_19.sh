#!/bin/bash
# 2026-05-19 Universe Expansion: test if adding new coins to Basket-18 helps.
# Basket-18 = 19er minus TRX (from Round 3 asset optimization).
# Candidates: DOGE, INJ, RUNE, SAND, STX (all USDT, all have funding).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/universe_expand
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
echo -e "label\tn\tpct\tpass\ttotal" >> "$RESULTS"

# Basket-18 (drop TRX, per Round 3 Asset Optimizer champion)
BASKET18="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --windows 334 --step-days 7 --threads 14 \
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
  local label="$1"; local syms="$2"; local outfile="$OUT/${label}.jsonl"
  local n=$(echo "$syms" | tr ',' '\n' | wc -l)
  echo "[run] $label (n=$n)"
  local raw=$($SWEEP $COMMON --symbols "$syms" --out "$outfile" 2>&1 | tail -3)
  echo "  $raw" | tr '\n' ' '; echo ""
  # Parse "pass: X/Y (Z.ZZ%)" or similar
  local pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  local pass_total=$(echo "$raw" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  local pass=$(echo "$pass_total" | cut -d/ -f1)
  local total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t$n\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

# Baseline confirmation
run "B00_basket18_baseline" "$BASKET18"

# +1 candidate each
run "B01_plus_DOGE" "${BASKET18},DOGEUSDT"
run "B02_plus_INJ"  "${BASKET18},INJUSDT"
run "B03_plus_RUNE" "${BASKET18},RUNEUSDT"
run "B04_plus_SAND" "${BASKET18},SANDUSDT"
run "B05_plus_STX"  "${BASKET18},STXUSDT"

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== Universe Expansion Sweep complete in ${ELAPSED}s ==="
echo ""
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
