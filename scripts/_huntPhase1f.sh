#!/bin/bash
# R29 Hunt Phase 1f: STACKING — combine the best parameters discovered:
#   tp-mult=0.65, mct=7, trail-pct=0.001-0.003, no-trail, drop=RUNE+INJ
#   profit-target Step 1 (0.08), Step 1.5 (0.06-0.07), Step 2 (0.05)
# Goal: reach 65% via additive parameter improvements.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase1f_$$.log"
LOG_FINAL=/tmp/hunt_phase1f.log
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

# Best individual: tp-mult=0.65 + mct=7 + trail-pct=0.002
run "STACK-A: tp=0.65 mct=7 tr=0.002" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002

# + drop weak
run "STACK-B: + drop=RUNE,INJ" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT
run "STACK-C: + drop=RUNE,INJ,SAND" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT,SANDUSDT
run "STACK-D: + drop=RUNE,INJ,DOGE" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT,DOGEUSDT

# + lower target
run "STACK-E: STACK-A + pt=0.07" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.07
run "STACK-F: STACK-A + pt=0.06" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.06
run "STACK-G: STACK-A + pt=0.05" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.05

# Triple + drop + lower target (key candidates)
run "MAX-1: full + drop=RUNE,INJ + pt=0.05" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.05
run "MAX-2: full + drop=RUNE,INJ + pt=0.06" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.06
run "MAX-3: full + drop=RUNE,INJ + pt=0.07" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.07

# tp-mult variants on best stack
run "STACK-H tp=0.70 + drop+pt0.07" --override-tp-mult 0.70 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.07
run "STACK-I tp=0.60 + drop+pt0.07" --override-tp-mult 0.60 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.07
run "STACK-J tp=0.55 + drop+pt0.07" --override-tp-mult 0.55 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.07

# no-trail variants (no-trail gave 59.20% standalone)
run "no-trail + drop+pt0.07" --disable-trail --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.07
run "no-trail + drop+pt0.06" --disable-trail --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.06
run "no-trail + drop+pt0.05" --disable-trail --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.05

# longer hold with drop weak
run "drop+pt0.05+hold336" --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.05 --override-hold-bars 336

# min-trading-days variations (some FTMO accounts have lower)
run "MAX-1 + mtd=0" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.05 --min-trading-days 0
run "MAX-1 + mtd=2" --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --drop-symbols RUNEUSDT,INJUSDT --profit-target 0.05 --min-trading-days 2

echo "" | tee -a "$LOG"
echo "=== TOP ===" | tee -a "$LOG"
awk '/^=== / {label=$0; next} /passed=/ {print $0, "@@", label}' "$LOG" | sort -t'(' -k2 -rn | head -20 | tee -a "$LOG"

cp -f "$LOG" "$LOG_FINAL"
