#!/bin/bash
# 2026-05-15 Hunt Wave 1 — find higher pass-rate for real FTMO 2-Step
# Iterates all PASSLOCK-sister configs with the champion voter set, measures P1+P2, ranks by combined Funded.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/wave1_results.tsv"
: > "$RESULTS"
echo -e "config\tP1\tP2\tcombined_pct" >> "$RESULTS"

# Champion voter set (same across all bases)
VOTERS="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 1000 --step-days 1 --threads 8"

run_pair() {
  local cfg="$1"
  local label="$2"
  local p1=$($SWEEP $COMMON $VOTERS --config "$cfg" --profit-target 0.10 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON $VOTERS --config "$cfg" --profit-target 0.05 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then
    echo "[skip] $label — sweep failed"
    return
  fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

CONFIGS=(
  "2h-trend-v5-amber-max-passlock"
  "2h-trend-v5-amber-passlock"
  "2h-trend-v5-amber-ext-passlock"
  "2h-trend-v5-amber-quartz-passlock"
  "2h-trend-v5-amber-passlock-daystage"
  "2h-trend-v5-amber-be-passlock"
  "2h-trend-v5-amber-ptp-passlock"
  "2h-trend-v5-amber-atr-passlock"
  "2h-trend-v5-amber-passlock-mptp"
  "2h-trend-v5-amber-passlock-timedecay"
  "2h-trend-v5-amber-passlock-sharpe"
  "2h-trend-v5-obsidian-passlock"
  "2h-trend-v5-topaz-passlock"
  "2h-trend-v5-rubin-passlock"
  "2h-trend-v5-sapphir-passlock"
  "2h-trend-v5-diamond-passlock"
  "2h-trend-v5-titanium-passlock"
  "2h-trend-v5-titanium-passlock-norune"
  "2h-trend-v5-titanium-passlock-lscool-tight"
  "2h-trend-v5-titanium-passlock-lscool-loose"
  "2h-trend-v5-titanium-passlock-mct5"
  "2h-trend-v5-titanium-passlock-corrcap2"
  "2h-trend-v5-titanium-passlock-todcut18"
  "2h-trend-v5-titanium-passlock-hunter"
)

for cfg in "${CONFIGS[@]}"; do
  run_pair "$cfg" "$cfg"
done

echo ""
echo "=== TOP 10 by combined Funded ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -11
