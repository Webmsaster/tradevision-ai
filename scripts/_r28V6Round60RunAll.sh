#!/usr/bin/env bash
# Round 60 multi-variant 8-shard parallel run.
# Each shard processes ~17 windows × 7 variants seriell. 8 shards parallel.
# Wallclock estimate: ~90-100min on 16-core machine.

set -e
cd "$(dirname "$0")/.."
LOG_DIR=scripts/cache_bakeoff/r60_logs
mkdir -p "$LOG_DIR"
START_TS=$(date +%s)

RESUME_FLAG=""
if [[ "${1:-}" == "--resume" ]]; then
  RESUME_FLAG="--resume"
  echo "[runner] RESUME mode — skipping already-done windows"
fi

PIDS=()
for s in 0 1 2 3 4 5 6 7; do
  node ./node_modules/.bin/tsx scripts/_r28V6Round60Shard.ts "$s" 8 $RESUME_FLAG \
    > "$LOG_DIR/shard_$s.log" 2>&1 &
  PIDS+=($!)
  echo "[runner] launched shard $s as pid ${PIDS[-1]}"
done

echo "[runner] waiting for all shards..."
for pid in "${PIDS[@]}"; do
  wait "$pid" || echo "[runner] shard pid $pid exited non-zero"
done

ELAPSED=$(( $(date +%s) - START_TS ))
echo "[runner] all shards done in ${ELAPSED}s ($((ELAPSED / 60))min)"

echo ""
echo "==== AGGREGATE ===="
node ./node_modules/.bin/tsx scripts/_r28V6Round60Aggregate.ts
