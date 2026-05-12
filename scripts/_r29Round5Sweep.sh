#!/usr/bin/env bash
# R29 Round 5 — Order-Flow + Volume-Profile signal classes (NEW).
# 5 configs × 8 shards parallel sequential. ~10min/config × 5 ≈ 50min total.
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round5Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 5 sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_R28_V6_CVD:r5cvd"
  "FTMO_DAYTRADE_24H_R28_V6_CVD_SHORT:r5cvdShort"
  "FTMO_DAYTRADE_24H_R28_V6_CVD_LONG:r5cvdLong"
  "FTMO_DAYTRADE_24H_R28_V6_VOLIMB:r5volImb"
  "FTMO_DAYTRADE_24H_R28_V6_VOLIMB_STRICT:r5volImbStrict"
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
echo "[$(date +%H:%M:%S)] R29 Round 5 sweep DONE" | tee -a "$LOG"
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
  printf "%-18s %3d / %3d = %s%%\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
done
