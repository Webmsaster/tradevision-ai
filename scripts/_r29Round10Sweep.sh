#!/usr/bin/env bash
# R29 Round 10 — TITANIUM 14-asset basket stacking variants
# (post R9 confirmed: TITANIUM PL = 55.56% step=28d honest, +10.7pp vs
#  R28_V6 9-asset PASSLOCK 44.85%; funding-filter inert on this basket).
#
# Goal: find the next +1-3pp hebel by stacking single-feature filters.
# step=28d for fast iteration (63 windows × 8 shards parallel ≈ 30min/cfg).
set -u
cd "$(dirname "$0")/.."

LOG=scripts/cache_bakeoff/_r29Round10Sweep.log
: > "$LOG"
echo "[$(date +%H:%M:%S)] R29 Round 10 TITANIUM stacking sweep start" | tee -a "$LOG"

CONFIGS=(
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_NORUNE:r10noRune"          # drop RUNE
  "FTMO_DAYTRADE_24H_V5_OBSIDIAN_PASSLOCK:r10obsidPL"                # +ARB → 15 assets
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_LSCOOL_TIGHT:r10lscool1"   # losses=1 cd=400
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_LSCOOL_LOOSE:r10lscool3"   # losses=3 cd=96
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_MCT5:r10mct5"              # max concurrent 5
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_CORRCAP2:r10corr2"         # max same-dir 2
  "FTMO_DAYTRADE_24H_V5_TITANIUM_PASSLOCK_TODCUT18:r10tod18"         # no entries after 18 UTC
)

STEP_DAYS=28

for entry in "${CONFIGS[@]}"; do
  CFG="${entry%%:*}"
  SLUG="${entry#*:}"
  echo "[$(date +%H:%M:%S)] >>> $SLUG ($CFG / step=${STEP_DAYS}d)" | tee -a "$LOG"
  rm -f "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl
  for i in 0 1 2 3 4 5 6 7; do
    # Generic R10 shard reads the asset list from cfg.assets directly so
    # 13/14/15-asset baskets all run correctly without script changes.
    node ./node_modules/tsx/dist/cli.mjs scripts/_r29Round10Shard.ts "$CFG" "$SLUG" "$i" 8 "$STEP_DAYS" \
      >> "$LOG" 2>&1 &
  done
  wait
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  if [ "$TOTAL" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", ($PASSED/$TOTAL)*100 }")
  else
    PCT="n/a"
  fi
  echo "[$(date +%H:%M:%S)] <<< $SLUG: $PASSED/$TOTAL = $PCT%" | tee -a "$LOG"
done

echo "" | tee -a "$LOG"
echo "=== R29-R10 AGGREGATE (TITANIUM stacking, baseline 55.56%) ===" | tee -a "$LOG"
for entry in "${CONFIGS[@]}"; do
  SLUG="${entry#*:}"
  PASSED=$(grep -h '"passed":true' "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  TOTAL=$(cat "scripts/cache_bakeoff/r29_${SLUG}_shard_"*.jsonl 2>/dev/null | wc -l)
  if [ "$TOTAL" -gt 0 ]; then
    PCT=$(awk "BEGIN { printf \"%.2f\", ($PASSED/$TOTAL)*100 }")
    DELTA=$(awk "BEGIN { printf \"%+.2f\", ($PASSED/$TOTAL)*100 - 55.56 }")
  else
    PCT="n/a"
    DELTA=""
  fi
  printf "%-12s %3d / %3d = %s%%   Δ %spp\n" "$SLUG" "$PASSED" "$TOTAL" "$PCT" "$DELTA" | tee -a "$LOG"
done
