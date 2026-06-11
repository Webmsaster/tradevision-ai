#!/bin/bash
# 2026-05-17 Phase 33 — Measure REAL per-window AND for current champion.
# Memory `goal_achieved` says 55.02% on 329 windows. Verify with current config.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17/per_window
mkdir -p "$OUT"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

LABEL="${1:-champion}"
shift || true

echo "[P1 sweep — pt=0.10/30d] $LABEL extra: $@"
$SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" --out "$OUT/${LABEL}_p1.jsonl" 2>&1 | tail -2

echo "[P2 sweep — pt=0.05/60d] $LABEL extra: $@"
$SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" --out "$OUT/${LABEL}_p2.jsonl" 2>&1 | tail -2

echo ""
python3 scripts/per_window_and.py "$OUT/${LABEL}_p1.jsonl" "$OUT/${LABEL}_p2.jsonl" "$LABEL"
