#!/bin/bash
# 2026-05-16 Phase 21 — Orthogonal strategy attempts.
# Champion + MR/breakout layers + completely different --signals modes.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase21_orthogonal.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

V02_BASE="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
CHAMP="--override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --max-days 45"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# O00 Champion-baseline (regime signal)
run "O00_champion_regime"        $V02_BASE

# O01-O04: also-fire-meanrev / also-fire-breakout layered on top of regime
run "O01_+also_fire_meanrev"     $V02_BASE --also-fire-meanrev
run "O02_+also_fire_breakout"    $V02_BASE --also-fire-breakout
run "O03_+also_meanrev+breakout" $V02_BASE --also-fire-meanrev --also-fire-breakout

# O05-O08: signals=r28v6 alone, with/without mean-rev addons
run "O05_signals_r28v6"          --signals r28v6
run "O06_signals_r28v6_+meanrev" --signals r28v6 --also-fire-meanrev
run "O07_signals_r28v6_+breakout" --signals r28v6 --also-fire-breakout
run "O08_signals_r28v6_+all"     --signals r28v6 --also-fire-meanrev --also-fire-breakout

# O09: signals=trend (single trend voter)
run "O09_signals_trend"          --signals trend

# O10: signals=breakout (pure breakout)
run "O10_signals_breakout"       --signals breakout

# O11: signals=meanrev (pure mean-reversion)
run "O11_signals_meanrev"        --signals meanrev

# Cross-asset variations on champion (ETH/SOL instead of BTC)
run "O12_ca_ETH_filter"          $V02_BASE --cross-asset-sym ETHUSDT --cross-asset-fast 9 --cross-asset-slow 21
run "O13_ca_SOL_filter"          $V02_BASE --cross-asset-sym SOLUSDT --cross-asset-fast 9 --cross-asset-slow 21

# No cross-asset filter (test if BTC filter is helping at all)
run "O14_no_cross_asset"         $V02_BASE

echo ""
echo "=== Phase 21 Orthogonal results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
