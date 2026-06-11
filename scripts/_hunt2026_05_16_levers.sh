#!/bin/bash
# 2026-05-16 Mega-Lever Hunt — test 25 high-impact CLI flags that weren't in earlier voter-hunts.
# Target: Combined Funded P1×P2 ≥ 50% single-account.
# Baseline: V02_4V_no-FVG (AMBER_MAX_PASSLOCK + 4 voters without SMC-FVG) = 29.61% Combined.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/lever_results.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

# Champion voter set (V02_4V_no-FVG)
VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BASE_CFG="2h-trend-v5-amber-max-passlock"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 14"

START_TS=$(date +%s)
COUNT=0
TOTAL=25

run() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"
    return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s] $label"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# ========== L01-L05: HTF MACD trend-gate ==========
run "L01_htf-macd-default"      --use-htf-macd-gate
run "L02_htf-macd-stride6"      --use-htf-macd-gate --htf-stride 6
run "L03_htf-macd-mag0.5"       --use-htf-macd-gate --htf-macd-min-magnitude 0.5
run "L04_htf-macd-rising-3"     --use-htf-macd-gate --htf-macd-rising-lookback 3
run "L05_htf-confirm"           --use-htf-confirm

# ========== L06-L10: Drawdown / loss-streak protection ==========
run "L06_pdd-3pct"              --pdd-from-peak 0.03 --pdd-factor 0.5
run "L07_pdd-2pct-aggr"         --pdd-from-peak 0.02 --pdd-factor 0.3
run "L08_idl-2pct"              --idl-threshold 0.02 --idl-factor 0.3
run "L09_idl-1.5pct"            --idl-threshold 0.015 --idl-factor 0.25
run "L10_lscool-2x96"           --lscool-after 2 --lscool-bars 96

# ========== L11-L15: Sharpe / time-decay sizing ==========
run "L11_sharpe-default"        --sharpe-sizing
run "L12_sharpe-w40-min5"       --sharpe-sizing --sharpe-window 40 --sharpe-min-trades 5
run "L13_td-day10-decay0.7"     --td-enable --td-start-day 10 --td-decay 0.7 --td-min-factor 0.4
run "L14_td-decay0.8"           --td-enable --td-start-day 8 --td-decay 0.8 --td-min-factor 0.5
run "L15_td-mode-aggr"          --td-enable --td-mode aggressive --td-start-day 5

# ========== L16-L20: Cross-asset BTC-filter ==========
run "L16_btc-trend-9-21"        --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21
run "L17_btc-trend-12-26"       --cross-asset-sym BTCUSDT --cross-asset-fast 12 --cross-asset-slow 26
run "L18_btc-trend-inv"         --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 --cross-asset-inverse
run "L19_eth-trend-9-21"        --cross-asset-sym ETHUSDT --cross-asset-fast 9 --cross-asset-slow 21

# ========== L20-L25: Combined stacking ==========
run "L20_stack-htf+pdd"         --use-htf-macd-gate --pdd-from-peak 0.03 --pdd-factor 0.5
run "L21_stack-htf+idl+lscool"  --use-htf-macd-gate --idl-threshold 0.02 --idl-factor 0.3 --lscool-after 2 --lscool-bars 96
run "L22_stack-all-protection"  --use-htf-macd-gate --pdd-from-peak 0.03 --pdd-factor 0.5 --idl-threshold 0.02 --idl-factor 0.3 --lscool-after 2 --lscool-bars 96
run "L23_stack-sharpe+htf"      --sharpe-sizing --use-htf-macd-gate
run "L24_stack-btc+htf"         --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 --use-htf-macd-gate
run "L25_stack-mega"            --use-htf-macd-gate --pdd-from-peak 0.03 --pdd-factor 0.5 --idl-threshold 0.02 --idl-factor 0.3 --lscool-after 2 --lscool-bars 96 --sharpe-sizing --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21

echo ""
echo "=== TOP 15 by combined Funded ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -16
