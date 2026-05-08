#!/usr/bin/env bash
# R29 Round 5 POC follow-up — 2 configs × 8 shards parallel sequential.
set -u
cd /home/flooe/projects/tradevision-ai

LOG=scripts/cache_bakeoff/_r29Round5PocSweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 5 POC sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_R28_V6_POC:r5poc"
  "FTMO_DAYTRADE_24H_R28_V6_POC_WIDE:r5pocWide"
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
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL passed" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 5 POC sweep DONE" | tee -a "$LOG"
