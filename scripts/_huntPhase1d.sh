#!/bin/bash
# R29 Hunt Phase 1d: daily-loss reduction via IDL/PDD/DPTS/CPTS throttles +
# combined param interactions. The audit showed daily_loss = 30.88% of fails;
# cutting that 10pp = pass-rate +10pp.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase1d_$$.log"
LOG_FINAL=/tmp/hunt_phase1d.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS" \
    --config 2h-trend-v5-titanium-passlock \
    --windows 200 --step-days 14 --signals per-asset \
    "$@" 2>&1 | tail -1 | tee -a "$LOG"; then
    # NOTE 2026-05-12: --phantom-suppress removed (R29 audit finding — inverted, under-counted).
    echo "[warn] $label failed — continuing" | tee -a "$LOG"
  fi
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
# awk state-machine: tolerant of intervening [warn] lines (R4 fix carried over
# from Phase 1 — old `grep -B1 | paste` pattern silently dropped entries when
# a sweep failed and the warn line came between the label and the next passed=).
awk '
  /^=== / { match($0, /=== (.+) ===/, m); if (m[1] != "") label = m[1]; next }
  /passed=/ {
    if (label != "" && match($0, /\(([0-9.]+)%\)/, p)) {
      print p[1] "  " label
      label = ""
    }
  }
' "$LOG" | sort -rn | head -20 | tee -a "$LOG"

cp -f "$LOG" "$LOG_FINAL"
