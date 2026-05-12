#!/usr/bin/env bash
# R29 Round 4 — sequential sweep over 8 PASSLOCK / LooseCap variants.
# Each config: 8 parallel shards. ~28min per config × 8 ≈ 3.5h wall-clock.
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round4Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 4 sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_V5_AMBER_PASSLOCK:amberPL"
  "FTMO_DAYTRADE_24H_V5_OBSIDIAN_PASSLOCK:obsidPL"
  "FTMO_DAYTRADE_24H_V5_QUARTZ_LITE_R28_PASSLOCK:liteR28PL"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_LOOSE_CAPS:passlockLoose"
  "FTMO_DAYTRADE_24H_V5_AMBER_LOOSE_CAPS:amberLoose"
  "FTMO_DAYTRADE_24H_V5_AMBER_PT08_PASSLOCK:amberPL08"
  "FTMO_DAYTRADE_24H_V5_OBSIDIAN_PT08_PASSLOCK:obsidPL08"
  "FTMO_DAYTRADE_24H_TREND_2H_V1_PASSLOCK_PT08:trend2hPL08"
)

for entry in "${CONFIGS[@]}"; do
  CFG="${entry%%:*}"
  SLUG="${entry#*:}"
  echo "[$(date +%H:%M:%S)] >>> $SLUG ($CFG)" | tee -a "$LOG"
  for i in 0 1 2 3 4 5 6 7; do
    node ./node_modules/tsx/dist/cli.mjs scripts/_r29GenericShard.ts "$CFG" "$SLUG" "$i" 8 \
      >> "$LOG" 2>&1 &
  done
  wait
  PASSED=$(awk -F'"passed":' '{print $2}' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | grep -c '^true,')
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL passed" | tee -a "$LOG"
done

echo "[$(date +%H:%M:%S)] R29 Round 4 sweep DONE" | tee -a "$LOG"

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
  printf "%-16s %3d / %3d = %s%%\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
done
