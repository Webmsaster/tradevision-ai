#!/usr/bin/env bash
# R29 Round 9 RESUME — only the missing FRLONG variant
# (PASSLOCK base + FRMED already done 2026-05-09 ~10:55 / ~11:05)
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round9FrlongResume.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 9 FRLONG resume start" | tee -a "$LOG"

CFG="FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_FRLONG"
SLUG="r9titFRLONG"
STEP_DAYS=28

for i in 0 1 2 3 4 5 6 7; do
  node ./node_modules/tsx/dist/cli.mjs scripts/_r29Round9TitaniumShard.ts "$CFG" "$SLUG" "$i" 8 "$STEP_DAYS" \
    >> "$LOG" 2>&1 &
done
wait

PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
PCT=$(awk "BEGIN { printf \"%.2f\", ($PASSED/$TOTAL)*100 }")
printf "[$(date +%H:%M:%S)] FRLONG: %d / %d = %s%%\n" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
