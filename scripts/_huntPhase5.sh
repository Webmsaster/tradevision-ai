#!/bin/bash
# R29 Hunt Phase 5: step=7 OOS native hunt — score by the rigorous metric.
# Goal: find a config with step=7 ≥ 65% AND Step 1 (pt=0.08) ≥ 65%.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase5_$$.log"
LOG_FINAL=/tmp/hunt_phase5.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS_BASE" \
    --windows 600 --step-days 7 --signals per-asset \
    --phantom-suppress "$@" 2>&1 | tail -1 | tee -a "$LOG"; then
    echo "[warn] $label failed — continuing" | tee -a "$LOG"
  fi
}

# Re-test top step=14 candidates AT step=7 to find honest baseline
run "STACK-G (claimed 66.40@s14)" --config 2h-trend-v5-titanium-passlock --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.05
run "STACK-G + pt=0.08" --config 2h-trend-v5-titanium-passlock --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.08
run "STACK-G + pt=0.06" --config 2h-trend-v5-titanium-passlock --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.06

# Other bases + STACK-G params
for cfg in 2h-trend-v5-amber 2h-trend-v5-topaz 2h-trend-v5-obsidian-passlock 2h-trend-v5-titanium 2h-trend-v5-titanium-passlock-norune; do
  run "$cfg + STACK-G" --config $cfg --override-tp-mult 0.65 --override-mct 7 --override-trail-pct 0.002 --profit-target 0.05
done

# Aggressive hour filters
for hours in "8,16" "12,20" "0,12" "8,20" "8,16,0" "12" "8" "20" "0,4,8,12,16,20"; do
  run "hours=$hours" --config 2h-trend-v5-titanium-passlock --override-hours "$hours" --profit-target 0.05
done

# DOWs filters (excluding weekend gaps)
for dows in "1,2,3,4" "2,3,4" "1,3,5" "0,1,2,3,4,5"; do
  run "dows=$dows" --config 2h-trend-v5-titanium-passlock --override-dows "$dows" --profit-target 0.05
done

# Hours + dows combined
run "hours=8,16 dows=2,3,4" --config 2h-trend-v5-titanium-passlock --override-hours "8,16" --override-dows "2,3,4" --profit-target 0.05

# Per-asset tpPct overrides via adaptive-tp
run "BTC tighter" --config 2h-trend-v5-titanium-passlock --adaptive-tp "BTC-TREND:0.025" --profit-target 0.05
run "BTC+ETH tight" --config 2h-trend-v5-titanium-passlock --adaptive-tp "BTC-TREND:0.025,ETH-TREND:0.025" --profit-target 0.05

# Per-asset overrides via funding-rate filtering
run "funding-max-long=0.0001" --config 2h-trend-v5-titanium-passlock --funding-max-long 0.0001 --profit-target 0.05
run "funding-min-short=-0.0001" --config 2h-trend-v5-titanium-passlock --funding-min-short -0.0001 --profit-target 0.05

# Strict drawdown shields
run "DPTS=0.020+CPTS=0.030" --config 2h-trend-v5-titanium-passlock --dpts-trail 0.020 --cpts-trail 0.030 --profit-target 0.05
run "DPTS=0.025+IDL=0.020" --config 2h-trend-v5-titanium-passlock --dpts-trail 0.025 --idl-threshold 0.020 --idl-factor 0.5 --profit-target 0.05

echo "" | tee -a "$LOG"
echo "=== TOP 20 STEP=7 ===" | tee -a "$LOG"
awk '/^=== / {label=$0; next} /passed=/ {print $0, "@@", label}' "$LOG" | sort -t'(' -k2 -rn | head -20 | tee -a "$LOG"

cp -f "$LOG" "$LOG_FINAL"
