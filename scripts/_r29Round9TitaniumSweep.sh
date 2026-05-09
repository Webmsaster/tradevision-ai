#!/usr/bin/env bash
# R29 Round 9 — funding-rate filter on V5_TITANIUM 14-asset basket.
# Uses step=28d for fast iteration (68 windows instead of 136).
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round9Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 9 TITANIUM+funding sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK:r9titPL"
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_FRMED:r9titFRMED"
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_FRLONG:r9titFRLONG"
)

STEP_DAYS=28

for entry in "${CONFIGS[@]}"; do
  CFG="${entry%%:*}"
  SLUG="${entry#*:}"
  echo "[$(date +%H:%M:%S)] >>> $SLUG ($CFG / step=${STEP_DAYS}d)" | tee -a "$LOG"
  for i in 0 1 2 3 4 5 6 7; do
    node ./node_modules/tsx/dist/cli.mjs scripts/_r29Round9TitaniumShard.ts "$CFG" "$SLUG" "$i" 8 "$STEP_DAYS" \
      >> "$LOG" 2>&1 &
  done
  wait
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL passed" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 9 sweep DONE" | tee -a "$LOG"
echo "" | tee -a "$LOG"
echo "=== AGGREGATE ===" | tee -a "$LOG"
for entry in "${CONFIGS[@]}"; do
  SLUG="${entry#*:}"
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  if [ "$TOTAL" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", ($PASSED/$TOTAL)*100 }")
  else
    PCT="n/a"
  fi
  printf "%-14s %3d / %3d = %s%%\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
done
