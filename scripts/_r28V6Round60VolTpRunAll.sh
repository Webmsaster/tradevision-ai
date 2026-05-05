#!/usr/bin/env bash
# Round 60 VolTp+IDLT shard run — runs in parallel with primary sweep.
set -e
cd "$(dirname "$0")/.."
LOG_DIR=scripts/cache_bakeoff/r60_logs
mkdir -p "$LOG_DIR"
START_TS=$(date +%s)

RESUME_FLAG=""
if [[ "${1:-}" == "--resume" ]]; then
  RESUME_FLAG="--resume"
  echo "[voltp-runner] RESUME mode — skipping already-done windows"
fi

PIDS=()
for s in 0 1 2 3 4 5 6 7; do
  node ./node_modules/.bin/tsx scripts/_r28V6Round60VolTpShard.ts "$s" 8 $RESUME_FLAG \
    > "$LOG_DIR/voltp_shard_$s.log" 2>&1 &
  PIDS+=($!)
  echo "[voltp-runner] launched shard $s as pid ${PIDS[-1]}"
done

echo "[voltp-runner] waiting..."
for pid in "${PIDS[@]}"; do
  wait "$pid" || echo "[voltp-runner] shard pid $pid exited non-zero"
done

ELAPSED=$(( $(date +%s) - START_TS ))
echo "[voltp-runner] all voltp shards done in ${ELAPSED}s ($((ELAPSED / 60))min)"
