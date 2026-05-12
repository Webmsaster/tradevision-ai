#!/bin/bash
# R29 Hunt Phase 1c: leverage / profit-target / hold-bars / step-2 sweeps
# on V5_TITANIUM_PASSLOCK base. Goal: find 65%+ via a parameter we haven't
# yet explored.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase1c.log
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

# Leverage sweep
for lev in 1.5 1.75 2.0 2.25 2.5 3.0; do
  run "lev=$lev" --override-leverage $lev
done

# Profit target sweep — Step1 = 0.08, Step2 = 0.05, but try in-between
for pt in 0.05 0.06 0.07 0.08 0.10; do
  run "pt=$pt" --profit-target $pt
done

# Hold-bars sweep — allow longer holds
for hb in 96 144 192 240 288 336; do
  run "hold=$hb" --override-hold-bars $hb
done

# Combined: lower target + longer hold (= Step2-like)
run "step2-ish pt=0.05 hold=336" --profit-target 0.05 --override-hold-bars 336
run "pt=0.06 hold=288" --profit-target 0.06 --override-hold-bars 288
run "pt=0.07 hold=288" --profit-target 0.07 --override-hold-bars 288

# Combined: tighter stop + smaller TP-mult (more wins, smaller TPs)
run "stop=0.015 tp-mult=0.45" --override-stop-pct 0.015 --override-tp-mult 0.45
run "stop=0.02 tp-mult=0.45" --override-stop-pct 0.02 --override-tp-mult 0.45
run "stop=0.025 tp-mult=0.50" --override-stop-pct 0.025 --override-tp-mult 0.50

# Combined: drop weak + tighter stop
for drop_combo in "RUNEUSDT,INJUSDT" "RUNEUSDT,INJUSDT,SANDUSDT" "RUNEUSDT,INJUSDT,DOGEUSDT,SANDUSDT,AVAXUSDT"; do
  run "drop=$drop_combo + stop=0.02" --drop-symbols "$drop_combo" --override-stop-pct 0.02
done

# Combined: drop weak + lower target
for drop_combo in "RUNEUSDT,INJUSDT" "RUNEUSDT,INJUSDT,SANDUSDT"; do
  run "drop=$drop_combo + pt=0.05 hold=288" --drop-symbols "$drop_combo" --profit-target 0.05 --override-hold-bars 288
done

# min_trading_days variants — FTMO 2-Step might allow lower
for mtd in 0 1 2 3 4 5; do
  run "mtd=$mtd" --min-trading-days $mtd
done

# BE threshold + tight trail combinations
for be in 0.01 0.015 0.02; do
  for tr in 0.001 0.003 0.005; do
    run "be=$be tr=$tr" --be-threshold $be --override-trail-pct $tr
  done
done

# disable-trail to see if trail is hurting
run "no-trail" --disable-trail

# Adaptive-tp per asset (just BTC tighter)
run "BTC tighter tp" --adaptive-tp "BTC-TREND:0.020"

echo "" | tee -a "$LOG"
echo "=== TOP 20 ===" | tee -a "$LOG"
grep -B1 "passed=" "$LOG" | paste -d'|' - - | awk -F'|' '{
  match($1, /=== (.+) ===/, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] != "") print pct[1] "  " lab[1];
}' | sort -rn | head -20 | tee -a "$LOG"
