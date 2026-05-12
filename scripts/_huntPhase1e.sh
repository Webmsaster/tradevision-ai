#!/bin/bash
# R29 Hunt Phase 1e: alternative signal sources on PASSLOCK base.
# Tests SignalSrc=Breakout/Trend/MeanRev as primary detector instead of R28V6.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase1e.log
> "$LOG"

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 200 --step-days 14 \
    --phantom-suppress "$@" 2>&1 | tail -1 | tee -a "$LOG"
}

# Pure alternative signals
run "trend-only" --signals trend
run "breakout-only" --signals breakout
run "meanrev-only" --signals meanrev

# Drop-symbols x signals
for sig in trend breakout meanrev; do
  run "$sig + drop weak" --signals "$sig" --drop-symbols RUNEUSDT,INJUSDT
done

# Combined per-asset r28v6 + also-fire variants (already in 1b but with different params)
run "+meanrev p10/20/80" --signals per-asset --also-fire-meanrev --mr-period 10 --mr-oversold 20 --mr-overbought 80
run "+meanrev p20/30/70" --signals per-asset --also-fire-meanrev --mr-period 20 --mr-oversold 30 --mr-overbought 70
run "+meanrev p7/25/75" --signals per-asset --also-fire-meanrev --mr-period 7 --mr-oversold 25 --mr-overbought 75

# Step-2 variant (lower target, longer hold)
run "Step2-like 5%/336bars" --signals per-asset --profit-target 0.05 --override-hold-bars 336 --min-trading-days 0

# Profit-target sweep with longer hold
for pt in 0.05 0.06 0.07; do
  for hb in 240 288 336; do
    run "pt=$pt hb=$hb" --signals per-asset --profit-target $pt --override-hold-bars $hb
  done
done

# Combined: Step-2 mode + drop weak
run "Step2 5%/336 + drop=RUNE,INJ" --signals per-asset --profit-target 0.05 --override-hold-bars 336 --min-trading-days 0 --drop-symbols RUNEUSDT,INJUSDT

echo "" | tee -a "$LOG"
echo "=== TOP 20 ===" | tee -a "$LOG"
grep -B1 "passed=" "$LOG" | paste -d'|' - - | awk -F'|' '{
  match($1, /=== (.+) ===/, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] != "") print pct[1] "  " lab[1];
}' | sort -rn | head -20 | tee -a "$LOG"
