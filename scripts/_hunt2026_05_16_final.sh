#!/bin/bash
# 2026-05-16 Final-Stack Hunt — built on top of L16 discovery (BTC-trend +4pp).
# Lever-Hunt finding: --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21
# alone gives Combined 33.85%. Stack with htf-macd, lscool, walk-forward, all-24-assets.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
SYMS_24="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOGEUSDT,DOTUSDT,ETCUSDT,ETHUSDT,INJUSDT,LINKUSDT,LTCUSDT,NEARUSDT,RUNEUSDT,SANDUSDT,SOLUSDT,STXUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/final_stack.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BASE_CFG="2h-trend-v5-amber-max-passlock"
COMMON19="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
COMMON24="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_24 --windows 334 --step-days 3 --threads 14"
# Core BTC-trend-filter lever (L16 winner)
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"

START_TS=$(date +%s)
COUNT=0
TOTAL=20

run19() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"; return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s 19asset] $label"
  local p1=$($SWEEP $COMMON19 --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON19 --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}
run24() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"; return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s 24asset] $label"
  local p1=$($SWEEP $COMMON24 --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON24 --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# ===== F01-F04: BTC-trend + lscool stack (winner candidates) =====
run19 "F01_BTC+lscool"          $BTC_FILTER --lscool-after 2 --lscool-bars 96
run19 "F02_BTC+lscool+htf"      $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate
run19 "F03_BTC+htf"             $BTC_FILTER --use-htf-macd-gate
run19 "F04_BTC+lscool-3x96"     $BTC_FILTER --lscool-after 3 --lscool-bars 96

# ===== F05-F07: BTC-trend EMA variations =====
run19 "F05_BTC-5-13"            --cross-asset-sym BTCUSDT --cross-asset-fast 5 --cross-asset-slow 13 --lscool-after 2 --lscool-bars 96
run19 "F06_BTC-7-15"            --cross-asset-sym BTCUSDT --cross-asset-fast 7 --cross-asset-slow 15 --lscool-after 2 --lscool-bars 96
run19 "F07_BTC-10-30"           --cross-asset-sym BTCUSDT --cross-asset-fast 10 --cross-asset-slow 30 --lscool-after 2 --lscool-bars 96

# ===== F08-F10: All 24 assets =====
run24 "F08_BTC+lscool_24"       $BTC_FILTER --lscool-after 2 --lscool-bars 96
run24 "F09_BTC+lscool+htf_24"   $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate
run24 "F10_BTC_24"              $BTC_FILTER

# ===== F11-F14: Walk-forward 2024+ + 2025+ recency =====
run19 "F11_BTC+lscool_2024+"    $BTC_FILTER --lscool-after 2 --lscool-bars 96 --start-after-ts 1704067200000
run19 "F12_BTC+lscool_2025+"    $BTC_FILTER --lscool-after 2 --lscool-bars 96 --start-after-ts 1735689600000
run24 "F13_BTC+lscool_24_2024+" $BTC_FILTER --lscool-after 2 --lscool-bars 96 --start-after-ts 1704067200000
run24 "F14_BTC+lscool+htf_24_2024+" $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate --start-after-ts 1704067200000

# ===== F15-F17: P2 leverage tweaks on best base =====
run19 "F15_BTC+lscool+P2lev0.5" $BTC_FILTER --lscool-after 2 --lscool-bars 96 --override-leverage 0.5
run19 "F16_BTC+lscool+P2lev0.7" $BTC_FILTER --lscool-after 2 --lscool-bars 96 --override-leverage 0.7
run19 "F17_BTC+lscool+P2hold500" $BTC_FILTER --lscool-after 2 --lscool-bars 96 --override-hold-bars 500

# ===== F18-F20: Stack ALL good levers =====
run19 "F18_MEGA_19"             $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate
run24 "F19_MEGA_24"             $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate
run24 "F20_MEGA_24_2024+"       $BTC_FILTER --lscool-after 2 --lscool-bars 96 --use-htf-macd-gate --start-after-ts 1704067200000

echo ""
echo "=== TOP 15 final stack ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -16
