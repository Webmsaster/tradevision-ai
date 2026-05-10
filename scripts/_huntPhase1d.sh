#!/bin/bash
# R29 Hunt Phase 1d: daily-loss reduction via IDL/PDD/DPTS/CPTS throttles +
# combined param interactions. The audit showed daily_loss = 30.88% of fails;
# cutting that 10pp = pass-rate +10pp.
set -e
cd "$(dirname "$0")/.."

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG=/tmp/hunt_phase1d.log
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

# Intraday Daily Loss throttle — reduces size after daily drawdown
for thr in 0.015 0.020 0.025 0.030; do
  for fac in 0.25 0.5 0.75; do
    run "idl-thr=$thr idl-fac=$fac" --idl-threshold $thr --idl-factor $fac
  done
done

# Daily Peak Trailing Stop — cut at trail distance from day-peak
for trail in 0.015 0.020 0.025 0.030 0.035 0.040; do
  run "dpts=$trail" --dpts-trail $trail
done

# Challenge Peak Trailing Stop — challenge-level
for trail in 0.030 0.040 0.050 0.060 0.080; do
  run "cpts=$trail" --cpts-trail $trail
done

# Peak Drawdown throttle — cut size when peak-drawdown exceeds
for from in 0.015 0.020 0.025; do
  for fac in 0.25 0.5 0.75; do
    run "pdd-from=$from pdd-fac=$fac" --pdd-from-peak $from --pdd-factor $fac
  done
done

# Combined: best DPTS + drop weak
run "dpts=0.025 + drop=RUNE,INJ" --dpts-trail 0.025 --drop-symbols RUNEUSDT,INJUSDT
run "dpts=0.030 + drop=RUNE,INJ" --dpts-trail 0.030 --drop-symbols RUNEUSDT,INJUSDT
run "dpts=0.025 + drop=RUNE,INJ,SAND" --dpts-trail 0.025 --drop-symbols RUNEUSDT,INJUSDT,SANDUSDT
run "idl=0.020/0.5 + dpts=0.025" --idl-threshold 0.020 --idl-factor 0.5 --dpts-trail 0.025
run "idl=0.020/0.5 + drop=RUNE,INJ" --idl-threshold 0.020 --idl-factor 0.5 --drop-symbols RUNEUSDT,INJUSDT

# Loss-streak cooldown variations
for after in 2 3 4; do
  for bars in 24 48 96 192; do
    run "lscool-$after/$bars" --lscool-after $after --lscool-bars $bars
  done
done

echo "" | tee -a "$LOG"
echo "=== TOP 20 ===" | tee -a "$LOG"
grep -B1 "passed=" "$LOG" | paste -d'|' - - | awk -F'|' '{
  match($1, /=== (.+) ===/, lab);
  match($2, /\(([0-9.]+)%\)/, pct);
  if (lab[1] != "" && pct[1] != "") print pct[1] "  " lab[1];
}' | sort -rn | head -20 | tee -a "$LOG"
