#!/usr/bin/env bash
# Round 61 Day-Risk variant sweep.
# Tests 4 variants (PASSLOCK baseline + 3 day-risk flavors).
# Wallclock estimate: ~30-50min on idle 16-core (8 shards × 4 variants).
#
# Usage:
#   bash scripts/_r28V6Round61RunAll.sh         # fresh run
#   bash scripts/_r28V6Round61RunAll.sh --resume  # skip already-done windows

set -e
cd "$(dirname "$0")/.."
LOG_DIR=scripts/cache_bakeoff/r61_logs
mkdir -p "$LOG_DIR"
START_TS=$(date +%s)

RESUME_FLAG=""
if [[ "${1:-}" == "--resume" ]]; then
  RESUME_FLAG="--resume"
  echo "[r61-runner] RESUME mode"
fi

PIDS=()
for s in 0 1 2 3 4 5 6 7; do
  node ./node_modules/.bin/tsx scripts/_r28V6Round61Shard.ts "$s" 8 $RESUME_FLAG \
    > "$LOG_DIR/shard_$s.log" 2>&1 &
  PIDS+=($!)
  echo "[r61-runner] launched shard $s as pid ${PIDS[-1]}"
done

echo "[r61-runner] waiting for all shards..."
for pid in "${PIDS[@]}"; do
  wait "$pid" || echo "[r61-runner] shard pid $pid exited non-zero"
done

ELAPSED=$(( $(date +%s) - START_TS ))
echo "[r61-runner] all shards done in ${ELAPSED}s ($((ELAPSED / 60))min)"

echo ""
echo "==== AGGREGATE ===="
node ./node_modules/.bin/tsx scripts/_r28V6Round61Aggregate.ts
