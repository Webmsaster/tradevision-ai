#!/bin/bash
# R29 Hunt Phase 2: cross-step audit on top candidates from Phase 1.
# Usage: _huntPhase2.sh <config1> [config2] [config3] ...
# Each config gets sweeps at step=3, 7, 14, 21, 28 — variance check.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }
[ "$#" -ge 1 ] || { echo "usage: $0 <config1> [config2 ...]" >&2; exit 1; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SYMS_R28V6="BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT,ETCUSDT,XRPUSDT,AAVEUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase2_$$.log"
LOG_FINAL=/tmp/hunt_phase2.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

run() {
  local cfg="$1"
  local step="$2"
  local syms="$3"
  echo "=== $cfg @ step=$step ===" | tee -a "$LOG"
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$syms" \
    --config "$cfg" \
    --windows 600 --step-days "$step" --signals per-asset \
    2>&1 | tail -1 | tee -a "$LOG"; then
    # NOTE 2026-05-12: --phantom-suppress removed (R29 audit finding — inverted, under-counted).
    echo "[warn] $cfg @ step=$step failed — continuing" | tee -a "$LOG"
  fi
}

for cfg in "$@"; do
  # Validate config name — only allow alphanumerics, dash, underscore (and case)
  [[ "$cfg" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: bad config name: $cfg" >&2; exit 1; }
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

cp -f "$LOG" "$LOG_FINAL"
