#!/bin/bash
# R29 Hunt Phase 1b: parameter overrides on V5_TITANIUM_PASSLOCK base.
# Searches TP/Stop/MCT/trail-pct grid that user-tunable existing templates miss.
set -e
cd "$(dirname "$0")/.."

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase1b.log
> "$LOG"

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 200 --step-days 14 --signals per-asset \
    --phantom-suppress "$@" 2>&1 | tail -1 | tee -a "$LOG"
}

# TP-Mult sweep on the per-asset baseline
for tp in 0.45 0.50 0.55 0.60 0.65 0.70 0.80; do
  run "tp-mult=$tp" --override-tp-mult $tp
done

# Stop sweep
for sp in 0.015 0.02 0.025 0.03 0.04; do
  run "stop=$sp" --override-stop-pct $sp
done

# MCT sweep
for mct in 3 4 5 7 8 10; do
  run "mct=$mct" --override-mct $mct
done

# Trail pct sweep
for tr in 0.001 0.002 0.003 0.005 0.008 0.012; do
  run "trail-pct=$tr" --override-trail-pct $tr
done

# Hours subset sweeps
for hours in "4,6,8,10,14,18" "0,4,8,12,16,20" "2,6,10,14,18,22" "8,12,16,20" "0,6,12,18"; do
  run "hours=$hours" --override-hours "$hours"
done

# DOWs subset sweeps (skip Sun=0, drop weekends, etc.)
for dows in "1,2,3,4,5" "1,2,3,4,5,6" "0,2,4" "1,3,5" "2,3,4"; do
  run "dows=$dows" --override-dows "$dows"
done

# DropSymbols ablation — try dropping each weak asset
for drop in "RUNEUSDT" "INJUSDT" "DOGEUSDT" "SANDUSDT" "RUNEUSDT,INJUSDT" "RUNEUSDT,INJUSDT,DOGEUSDT" "RUNEUSDT,INJUSDT,DOGEUSDT,SANDUSDT"; do
  run "drop=$drop" --drop-symbols "$drop"
done

# also-fire-meanrev / breakout combinations
run "+meanrev p14 25/75" --also-fire-meanrev --mr-period 14 --mr-oversold 25 --mr-overbought 75
run "+meanrev p14 30/70" --also-fire-meanrev --mr-period 14 --mr-oversold 30 --mr-overbought 70
run "+breakout" --also-fire-breakout
run "+both" --also-fire-meanrev --also-fire-breakout

# BE threshold sweep
for be in 0.005 0.01 0.015 0.02 0.025; do
  run "be-thr=$be" --be-threshold $be
done

echo ""
echo "=== TOP 10 ==="
grep -B1 "passed=" "$LOG" | paste -d'|' - - | awk -F'|' '{
  match($1, /=== (.+) ===/, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] != "") print pct[1] "  " lab[1];
}' | sort -rn | head -20 | tee -a "$LOG"
