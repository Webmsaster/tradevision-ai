#!/bin/bash
# R29 Hunt Phase 1: sweep every existing config at step=14d, ≥120 windows.
# Output: pass-rate per config, sorted descending. Any config ≥60% goes to Phase 2.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing — build via cargo build --release" >&2; exit 3; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SYMS_R28V6="BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT,ETCUSDT,XRPUSDT,AAVEUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase1.log
> "$LOG"

run() {
  local cfg="$1"
  local syms="$2"
  local extra="$3"
  echo "=== $cfg ($extra) ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$syms" \
    --config "$cfg" \
    --windows 200 --step-days 14 --signals per-asset \
    --phantom-suppress $extra 2>&1 | tail -2 | tee -a "$LOG"
}

# 14-asset basket configs
for cfg in \
  "2h-trend-v5-titanium-passlock" \
  "2h-trend-v5-titanium-passlock-norune" \
  "2h-trend-v5-titanium-passlock-corrcap2" \
  "2h-trend-v5-titanium-passlock-lscool-tight" \
  "2h-trend-v5-titanium-passlock-lscool-loose" \
  "2h-trend-v5-titanium-passlock-mct5" \
  "2h-trend-v5-titanium-passlock-todcut18" \
  "2h-trend-v5-titanium-passlock-hunter" \
  "2h-trend-v5-obsidian-passlock" \
  "2h-trend-v5-titanium" \
  "2h-trend-v5-amber" \
  "2h-trend-v5-topaz"; do
  run "$cfg" "$SYMS_BASE" ""
done

# 9-asset basket configs (R28_V6 family)
for cfg in \
  "2h-trend-v5-r28-v6-passlock" \
  "2h-trend-v5-quartz-lite-r28-v6"; do
  run "$cfg" "$SYMS_R28V6" ""
done

echo "" | tee -a "$LOG"
echo "=== SORTED ===" | tee -a "$LOG"
grep -B1 "passed=" "$LOG" | paste - - - | awk -F'\t' '{ split($1, a, " "); split($3, b, " "); split(b[1], c, "%"); split(c[1], d, "("); print d[2] " " a[2] " " a[3] }' | sort -rg | tee -a "$LOG"
