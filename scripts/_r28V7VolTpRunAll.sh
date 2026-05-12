#!/bin/bash
# Master orchestrator for R28_V7 vol-adaptive TP sweep.
#
# Strategy: 5 variants × 8 shards = 40 shard-runs.
# Run shards sequentially per variant to keep RAM under control,
# but the *outer* loop iterates variants. Per-variant wallclock
# ~5-7 min (8 shards × 17 windows × ~20s per window / parallel-degree).
#
# Parallelism: 4 shards in parallel per variant (max RAM ~6 GiB).
#
# Each shard has its own log; aggregator merges per-variant.
set -u
cd "$(dirname "$0")/.."

LOG_DIR="/tmp"
PROGRESS_LOG="$LOG_DIR/r28v7_voltp_progress.log"
SHARD_COUNT=8
PARALLEL=4

VARIANTS=(V0 V1 V2 V3 V4)

mkdir -p scripts/cache_voltp_r28v7
rm -f scripts/cache_voltp_r28v7/r28v7_*.jsonl
rm -f /tmp/r28v7_voltp_v*_shard_*.log

echo "[master] $(date '+%Y-%m-%d %H:%M:%S') START" | tee -a "$PROGRESS_LOG"
echo "[master] variants=${VARIANTS[*]} shards=$SHARD_COUNT parallel=$PARALLEL" | tee -a "$PROGRESS_LOG"

for VAR in "${VARIANTS[@]}"; do
  echo "[master] $(date '+%H:%M:%S') === START $VAR ===" | tee -a "$PROGRESS_LOG"
  T_VAR_START=$(date +%s)

  PIDS=()
  RUNNING=0
  for SHARD in $(seq 0 $((SHARD_COUNT - 1))); do
    LOG="/tmp/r28v7_voltp_${VAR,,}_shard_${SHARD}.log"
    VARIANT="$VAR" setsid nohup node --max-old-space-size=1500 --import tsx scripts/_r28V7VolTpShard.ts "$SHARD" "$SHARD_COUNT" \
      > "$LOG" 2>&1 < /dev/null &
    PIDS+=($!)
    RUNNING=$((RUNNING + 1))
    if [ $RUNNING -ge $PARALLEL ]; then
      # wait for the OLDEST background job
      wait "${PIDS[0]}" 2>/dev/null || true
      PIDS=("${PIDS[@]:1}")
      RUNNING=$((RUNNING - 1))
    fi
  done
  # drain remaining
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  T_VAR=$(($(date +%s) - T_VAR_START))
  N_LINES=0
  for SHARD in $(seq 0 $((SHARD_COUNT - 1))); do
    f="scripts/cache_voltp_r28v7/r28v7_${VAR}_shard_${SHARD}.jsonl"
    if [ -s "$f" ]; then
      N_LINES=$((N_LINES + $(wc -l < "$f")))
    fi
  done
  echo "[master] $(date '+%H:%M:%S') === DONE $VAR — ${T_VAR}s — ${N_LINES} window-results ===" | tee -a "$PROGRESS_LOG"
done

echo "[master] $(date '+%H:%M:%S') ALL VARIANTS DONE — running aggregator" | tee -a "$PROGRESS_LOG"
node --import tsx scripts/_r28V7VolTpAggregate.ts | tee -a "$PROGRESS_LOG"
echo "[master] $(date '+%H:%M:%S') FULL DONE" | tee -a "$PROGRESS_LOG"
