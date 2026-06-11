#!/bin/bash
# 2026-05-17 Phase 38-Q — PTP winner + neutral voters combo.
# Hypothesis: P06 PTP (0.08:0.25) is +0.71pp. cmf + stop_hunt + cme_basis +
# nupl + cb_premium + stablecoin + top_trader_ls all TIE individually.
# Maybe one of them adds incrementally when stacked with PTP.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase38q_ptp_combos.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && { echo "[skip-empty] $label"; return; }
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Baseline P06 PTP
run "B00_p06_only"

# Add neutral voters from Phase 30-Q (all TIE individually)
run "B01_p06+cmf" --regime-use-cmf
run "B02_p06+stop_hunt" --regime-stophunt
run "B03_p06+cme_basis" --regime-use-cme-basis
run "B04_p06+nupl" --regime-use-nupl
run "B05_p06+top_trader_ls" --regime-use-top-trader-ls
run "B06_p06+stablecoin" --regime-use-stablecoin
run "B07_p06+cb_premium" --regime-use-cb-premium

# Try 2-voter combos with cmf + stop_hunt (both true logic voters, not data-deps)
run "B08_p06+cmf+stop_hunt" --regime-use-cmf --regime-stophunt
run "B09_p06+cmf+cb_premium" --regime-use-cmf --regime-use-cb-premium

echo ""
echo "=== Phase 38-Q PTP+voter combos (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head
