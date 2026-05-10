#!/bin/bash
# R29 Hunt Phase 4: deep-audit for any candidate ≥65% pass-rate.
# Usage: _huntPhase4.sh <config> [overrides...]
# Six bug-checks:
#   1. Cross-step variance (ranges step=3,7,14,21,28)
#   2. Walk-forward train/test split (4 quartiles)
#   3. Larger window count (250-500 windows for stable estimate)
#   4. Disable phantom-suppress to confirm bugfix wasn't masking
#   5. Drop random 2-3 assets — robustness check
#   6. With --random-gate-keep 0.5: trade-count reduction baseline
set -e
cd "$(dirname "$0")/.."

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase4.log
> "$LOG"

cfg="$1"
shift
extras=("$@")
[ -z "$cfg" ] && { echo "usage: $0 <config> [extra-flags...]"; exit 1; }

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS_BASE" \
    --config "$cfg" \
    --signals per-asset \
    "${extras[@]}" "$@" 2>&1 | tail -2 | tee -a "$LOG"
}

echo "###### PHASE 4 DEEP-AUDIT for $cfg + ${extras[*]} ######" | tee -a "$LOG"

# 1. Cross-step variance
for step in 3 7 14 21 28; do
  run "step=$step phantom" --windows 600 --step-days $step --phantom-suppress
done

# 2. Walk-forward 4-quartile (post-2022 cutoffs)
for cutoff_ts in 1641000000000 1672531200000 1704067200000 1735689600000; do
  iso=$(date -u -d "@$(( cutoff_ts / 1000 ))" +%Y-%m 2>/dev/null || echo "$cutoff_ts")
  run "post-$iso" --windows 200 --step-days 14 --start-after-ts $cutoff_ts --phantom-suppress
done

# 3. Big-N
run "BIG-N step=14 W=400" --windows 400 --step-days 14 --phantom-suppress
run "BIG-N step=7 W=800" --windows 800 --step-days 7 --phantom-suppress

# 4. Without phantom-suppress (compare)
run "NO phantom-suppress (sanity)" --windows 200 --step-days 14

# 5. Drop random 2-3 assets — robustness
run "drop AAVE+ETC" --windows 200 --step-days 14 --phantom-suppress --drop-symbols AAVEUSDT,ETCUSDT
run "drop BTC+ETH" --windows 200 --step-days 14 --phantom-suppress --drop-symbols BTCUSDT,ETHUSDT
run "drop AAVE+ETC+SAND" --windows 200 --step-days 14 --phantom-suppress --drop-symbols AAVEUSDT,ETCUSDT,SANDUSDT

# 6. Trade-count reduction baseline — does cutting trades alone explain the edge?
run "random-gate keep=0.5" --windows 200 --step-days 14 --phantom-suppress --random-gate-keep 0.5
run "random-gate keep=0.7" --windows 200 --step-days 14 --phantom-suppress --random-gate-keep 0.7

echo "" | tee -a "$LOG"
echo "=== PHASE 4 SUMMARY ($cfg) ===" | tee -a "$LOG"
grep -E "===|passed=" "$LOG" | tee -a "$LOG"
