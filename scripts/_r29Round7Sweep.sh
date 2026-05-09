#!/usr/bin/env bash
# R29 Round 7 — funding-rate filter sweep (4 configs × 8 shards parallel sequential).
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round7Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 7 sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRMILD:r7frmild"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRMED:r7frmed"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRSTRICT:r7frstrict"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRLONG:r7frlong"
)

for entry in "${CONFIGS[@]}"; do
  CFG="${entry%%:*}"
  SLUG="${entry#*:}"
  echo "[$(date +%H:%M:%S)] >>> $SLUG ($CFG)" | tee -a "$LOG"
  for i in 0 1 2 3 4 5 6 7; do
    node ./node_modules/tsx/dist/cli.mjs scripts/_r29Round7Shard.ts "$CFG" "$SLUG" "$i" 8 \
      >> "$LOG" 2>&1 &
  done
  wait
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL passed" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 7 sweep DONE" | tee -a "$LOG"
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
  printf "%-12s %3d / %3d = %s%%\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
done
