#!/bin/bash
# 2026-05-19 — 3-config stacking hunt
# Goal: find best 3-config combination for multi-account FTMO stack
# Spec: pt=0.10, tp=1.10, kf=0.5, ptp=none, strict-pass, max-days=30, windows=334, step-days=7
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/3stack_hunt
mkdir -p "$OUT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 7 --threads 4 --strict-pass --profit-target 0.10 --max-days 30 --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

CONFIGS=(
  "2h-trend-v5-amber-max-passlock"
  "2h-trend-v5-amber-quartz-passlock"
  "2h-trend-v5-amber-ext-passlock"
  "2h-trend-v5-amber-passlock-daystage"
  "2h-trend-v5-amber-passlock-timedecay"
  "2h-trend-v5-amber-passlock-sharpe"
  "2h-trend-v5-topaz-passlock"
  "2h-trend-v5-rubin-passlock"
  "2h-trend-v5-titanium-passlock"
  "2h-trend-v5-amber-max-passlock-bidir"
  "2h-trend-v5-amber-passlock"
  "2h-trend-v5-r28-v6-passlock"
)

for cfg in "${CONFIGS[@]}"; do
  label=$(echo "$cfg" | sed 's/2h-trend-v5-//;s/2h-trend-//;s/-/_/g')
  out_file="$OUT/${label}.jsonl"
  echo "[$cfg] -> $out_file"
  $SWEEP $COMMON --config "$cfg" --out "$out_file" 2>&1 | tail -2 || {
    echo "[ERROR] $cfg failed"
    continue
  }
done

echo ""
echo "=== Outputs in $OUT ==="
ls -lh "$OUT/"
