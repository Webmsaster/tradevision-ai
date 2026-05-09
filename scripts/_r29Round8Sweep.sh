#!/usr/bin/env bash
# R29 Round 8 — stack funding + cross-mom + regime masks (4 variants × 8 shards).
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round8Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 8 sweep start" | tee -a "$LOG"

# Format: <CONFIG>:<SLUG>:<MASK_MODE>
# Configs: PASSLOCK base + funding-FRMED variant (R7 winner candidate)
CONFIGS=(
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK:r8crossmom:crossmom"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK:r8regime:regime"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK:r8stacked:stacked"
  "FTMO_DAYTRADE_24H_R28_V6_PASSLOCK_FRMED:r8frmedCM:crossmom"
)

for entry in "${CONFIGS[@]}"; do
  CFG="${entry%%:*}"
  REST="${entry#*:}"
  SLUG="${REST%%:*}"
  MODE="${REST#*:}"
  echo "[$(date +%H:%M:%S)] >>> $SLUG ($CFG / mask=$MODE)" | tee -a "$LOG"
  for i in 0 1 2 3 4 5 6 7; do
    node ./node_modules/tsx/dist/cli.mjs scripts/_r29Round8Shard.ts "$CFG" "$SLUG" "$i" 8 "$MODE" \
      >> "$LOG" 2>&1 &
  done
  wait
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL passed" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 8 sweep DONE" | tee -a "$LOG"
echo "" | tee -a "$LOG"
echo "=== AGGREGATE ===" | tee -a "$LOG"
for entry in "${CONFIGS[@]}"; do
  REST="${entry#*:}"
  SLUG="${REST%%:*}"
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  if [ "$TOTAL" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", ($PASSED/$TOTAL)*100 }")
  else
    PCT="n/a"
  fi
  printf "%-14s %3d / %3d = %s%%\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" | tee -a "$LOG"
done
