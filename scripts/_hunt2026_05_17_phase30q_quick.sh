#!/bin/bash
# 2026-05-17 Phase 30-Q — Quick 100-window screen of pre-25 voters.
# Replaces slow 334-window Phase 30. Top-N then verified on full 334 in Phase 31.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase30q_pre25_quick.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1_100w\tP2_100w\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

run "Z00_champion"
run "K01_+kalman_trend" --regime-use-kalman-trend
run "K02_+aroon" --regime-use-aroon
run "K03_+cmf" --regime-use-cmf
run "K04_+ofi" --regime-use-ofi
run "K05_+smc_fvg" --regime-use-smc-fvg
run "K06_+rsi_hidden_div" --regime-use-rsi-hidden-div
run "K07_+vwap_trend" --regime-vwap-trend
run "K08_+stop_hunt" --regime-stophunt
run "K09_+double_top" --regime-use-double-top
run "K10_+cme_basis" --regime-use-cme-basis
run "K11_+top_trader_ls" --regime-use-top-trader-ls
run "K12_+nupl" --regime-use-nupl
run "K13_+cb_premium" --regime-use-cb-premium
run "K14_+stablecoin" --regime-use-stablecoin

echo ""
echo "=== Phase 30-Q quick (sorted by Combined desc) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -16
