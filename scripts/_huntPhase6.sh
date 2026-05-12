#!/bin/bash
# R29 Hunt Phase 6: untested directions on V5_TITANIUM_PASSLOCK at step=7.
# Focus: extreme parameter regimes, inverted risk-reward, single-asset baselines.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase6.log
> "$LOG"

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 400 --step-days 7 --signals per-asset \
    --phantom-suppress "$@" 2>&1 | tail -1 | tee -a "$LOG"
}

# Inverted risk-reward: tighter stops, looser TPs
for sp in 0.010 0.012 0.015; do
  for tp in 0.40 0.50 0.60; do
    run "stop=$sp tp=$tp" --override-stop-pct $sp --override-tp-mult $tp --profit-target 0.05
  done
done

# Larger TPs (might catch fat tails)
for tp in 0.80 0.90 1.00 1.10; do
  run "tp-mult=$tp" --override-tp-mult $tp --profit-target 0.05
done

# Single-asset baselines (BTC alone, ETH alone)
for asset in "BTCUSDT" "ETHUSDT" "BTCUSDT,ETHUSDT" "BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT" "BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT"; do
  run "basket=$asset" --keep-symbols "$asset" --profit-target 0.05
done

# Hours: Asian/Eu/US session subsets (UTC)
run "Asian: 0,2,4,6" --override-hours "0,2,4,6" --profit-target 0.05
run "EU: 6,8,10,12" --override-hours "6,8,10,12" --profit-target 0.05
run "US: 12,14,16,18,20" --override-hours "12,14,16,18,20" --profit-target 0.05
run "EU+US overlap 12,14,16" --override-hours "12,14,16" --profit-target 0.05

# Step 2 sustained (pt=0.05) + lower MCT for stricter
for mct in 1 2 3; do
  run "mct=$mct + pt=0.05" --override-mct $mct --profit-target 0.05
done

# Combined: best discovered + new directions
run "STACK-G + Asian session" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --override-hours "0,2,4,6" --profit-target 0.05
run "STACK-G + EU session" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --override-hours "6,8,10,12" --profit-target 0.05
run "STACK-G + US session" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --override-hours "12,14,16,18,20" --profit-target 0.05

# BTC+ETH only with full stack (smallest, lowest correlation basket)
run "BTC+ETH + STACK-G" --keep-symbols "BTCUSDT,ETHUSDT" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.05
run "Top4 + STACK-G" --keep-symbols "BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.05

echo "" | tee -a "$LOG"
echo "=== TOP 20 STEP=7 ===" | tee -a "$LOG"
cat "$LOG" | awk '/^=== / {label=$0; next} /passed=/ {print $0, "@@", label}' | sort -t'(' -k2 -rn | head -20 | tee -a "$LOG"
