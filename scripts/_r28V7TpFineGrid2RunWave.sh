#!/usr/bin/env bash
# Wave runner for R28_V7 TP Fine-Grid v2 — Round 60.
#
# Usage:
#   ./scripts/_r28V7TpFineGrid2RunWave.sh "0.35 0.45 0.50 0.55"
#
# Spawns 4 variants × 8 shards = 32 parallel node processes.
# Each shard writes to /tmp/r28v7_tpfg2_tp{multX100}_shard_{idx}.{jsonl,log}.
# Waits for all to finish.

set -u
cd "$(dirname "$0")/.."
PROG_FILE=/tmp/r28v7_tpfg2_progress.log
WAVE_LABEL="${WAVE_LABEL:-W?}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"<mult1> <mult2> ...\""
  exit 1
fi

MULTS="$1"
echo "[$(date -Iseconds)] [$WAVE_LABEL] starting wave with tpMults=$MULTS" | tee -a "$PROG_FILE"

PIDS=()
for m in $MULTS; do
  for s in 0 1 2 3 4 5 6 7; do
    node --import tsx scripts/_r28V7TpFineGrid2Shard.ts "$s" 8 "$m" \
      > "/tmp/r28v7_tpfg2_wave_${m}_shard_${s}.stdout" 2>&1 &
    PIDS+=($!)
  done
  echo "[$(date -Iseconds)] [$WAVE_LABEL] launched 8 shards for tpMult=$m" | tee -a "$PROG_FILE"
done

echo "[$(date -Iseconds)] [$WAVE_LABEL] ${#PIDS[@]} processes started, waiting..." | tee -a "$PROG_FILE"

FAILED=0
for p in "${PIDS[@]}"; do
  if ! wait "$p"; then
    FAILED=$((FAILED+1))
  fi
done

echo "[$(date -Iseconds)] [$WAVE_LABEL] wave done. failed=$FAILED" | tee -a "$PROG_FILE"
exit 0
