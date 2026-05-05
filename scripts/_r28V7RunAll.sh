#!/bin/bash
# Master orchestrator for the R28_V7 per-asset greedy sweep.
#
# IMPORTANT: this is the SEQUENTIAL version. Previous attempts:
#   * 10 parallel  -> OOM-killer killed all shards (each shard peaks ~1.5 GiB)
#   * 4 parallel   -> OOM with concurrent vitest from another Claude session
#   * 2 parallel   -> CPU contention, 5+ min per variant
# Sequential at ~150s per variant × 27 variants (3 mults × 9 assets) +
# 1 baseline ≈ 70 min total. Safe under any concurrent workload.
set -u
cd "$(dirname "$0")/.."

LOG_DIR="/tmp/r28v7_greedy_logs"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log "$LOG_DIR"/*.txt

TASKS=(baseline 0 1 2 3 4 5 6 7 8)

ALL_PIDS=()

run_task() {
  local t=$1
  setsid nohup node --max-old-space-size=1500 --import tsx scripts/_r28V7PerAssetGreedyShard.ts "$t" \
    > "$LOG_DIR/shard_${t}.log" 2>&1 < /dev/null &
  local pid=$!
  ALL_PIDS+=($pid)
  echo "[master] $(date +%H:%M:%S) spawned task=$t pid=$pid"
  wait "$pid"
  local rc=$?
  echo "[master] $(date +%H:%M:%S) task=$t pid=$pid exited rc=$rc"
}

for t in "${TASKS[@]}"; do
  run_task "$t"
done

# Verify all shards produced output
FAILED=0
for t in "${TASKS[@]}"; do
  f="scripts/cache_bakeoff/r28v7_greedy_${t}.jsonl"
  if [ ! -s "$f" ]; then
    echo "[master] FAIL: $f is empty"
    FAILED=$((FAILED + 1))
  else
    n=$(wc -l < "$f")
    echo "[master] OK: $f has $n lines"
  fi
done

printf "%s\n" "${ALL_PIDS[@]}" > "$LOG_DIR/pids.txt"
echo "[master] $(date +%H:%M:%S) all shards done. failed=$FAILED"
exit "$FAILED"
