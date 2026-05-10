#!/bin/bash
# R29 Hunt Phase 2: cross-step audit on top candidates from Phase 1.
# Usage: _huntPhase2.sh <config1> [config2] [config3] ...
# Each config gets sweeps at step=3, 7, 14, 21, 28 — variance check.
set -e
cd "$(dirname "$0")/.."

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SYMS_R28V6="BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT,ETCUSDT,XRPUSDT,AAVEUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase2.log
> "$LOG"

run() {
  local cfg="$1"
  local step="$2"
  local syms="$3"
  echo "=== $cfg @ step=$step ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$syms" \
    --config "$cfg" \
    --windows 600 --step-days $step --signals per-asset \
    --phantom-suppress 2>&1 | tail -1 | tee -a "$LOG"
}

for cfg in "$@"; do
  syms="$SYMS_BASE"
  case "$cfg" in
    *r28-v6*) syms="$SYMS_R28V6" ;;
  esac
  for step in 3 7 14 21 28; do
    run "$cfg" "$step" "$syms"
  done
done
echo "" | tee -a "$LOG"
echo "=== SUMMARY ===" | tee -a "$LOG"
grep -E "===|passed=" "$LOG" | tee -a "$LOG"
