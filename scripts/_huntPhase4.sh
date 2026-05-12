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
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase4_$$.log"
LOG_FINAL=/tmp/hunt_phase4.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

cfg="${1:-}"
[ -z "$cfg" ] && { echo "usage: $0 <config> [extra-flags...]"; exit 1; }
# Validate config name to avoid shell-injection
[[ "$cfg" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: bad config name: $cfg" >&2; exit 1; }
shift
extras=("$@")

# Portable epoch → ISO helper for walk-forward quartile labels
iso_date_from_epoch() {
  local epoch_s="$1"
  local fmt="${2:-%Y-%m}"
  if date -u -d "@$epoch_s" "+$fmt" >/dev/null 2>&1; then
    date -u -d "@$epoch_s" "+$fmt"
  else
    python3 -c "import datetime,sys; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).strftime(sys.argv[2]))" "$epoch_s" "$fmt"
  fi
}

run() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  # Merge caller extras with per-call flags, guarded for set -u empty-array.
  local -a all=()
  if [ "${#extras[@]}" -gt 0 ]; then all+=("${extras[@]}"); fi
  if [ "$#" -gt 0 ]; then all+=("$@"); fi
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$SYMS_BASE" \
    --config "$cfg" \
    --signals per-asset \
    ${all[@]+"${all[@]}"} 2>&1 | tail -3 | tee -a "$LOG"; then
    echo "[warn] $label failed — continuing" | tee -a "$LOG"
  fi
}

echo "###### PHASE 4 DEEP-AUDIT for $cfg + ${extras[*]} ######" | tee -a "$LOG"

# 1. Cross-step variance
for step in 3 7 14 21 28; do
  run "step=$step phantom" --windows 600 --step-days $step --phantom-suppress
done

# 2. Walk-forward 4-quartile (post-2022 cutoffs) — portable date conversion
for cutoff_ts in 1641000000000 1672531200000 1704067200000 1735689600000; do
  iso=$(iso_date_from_epoch "$(( cutoff_ts / 1000 ))" %Y-%m 2>/dev/null || echo "$cutoff_ts")
  run "post-$iso" --windows 200 --step-days 14 --start-after-ts "$cutoff_ts" --phantom-suppress
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

cp -f "$LOG" "$LOG_FINAL"
