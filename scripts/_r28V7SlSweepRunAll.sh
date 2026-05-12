#!/bin/bash
# Master orchestrator for the R28_V7 SL-multiplier sweep.
#
# Phases:
#   1. Uniform stopMult ∈ {0.6, 0.8, 1.0, 1.2, 1.4, 1.6}  (6 tasks)
#   2. Per-asset stopMult ∈ {0.7, 1.0, 1.4}  (9 asset-tasks × 3 mults each)
#   3. Aggregator builds combo spec from helpful picks; combo task is then run
#
# Sequential to avoid OOM (each shard peaks ~1.5 GiB; 16-core box can host
# ~6 parallel but the user's concurrent vitest sessions reliably trigger OOM
# kills under heavy contention — see _r28V7RunAll.sh history).
set -u
cd "$(dirname "$0")/.."

LOG_DIR="/tmp/r28v7_sl_logs"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log
rm -f scripts/cache_bakeoff/r28v7_sl_*.jsonl

# Phase 1+2 task list
TASKS=(u_0.6 u_0.8 u_1.0 u_1.2 u_1.4 u_1.6 0 1 2 3 4 5 6 7 8)

ALL_PIDS=()

run_task() {
  local t=$1
  setsid nohup node --max-old-space-size=1500 --import tsx scripts/_r28V7SlSweepShard.ts "$t" \
    > "$LOG_DIR/shard_${t}.log" 2>&1 < /dev/null &
  local pid=$!
  ALL_PIDS+=($pid)
  echo "[master] $(date +%H:%M:%S) spawned task=$t pid=$pid"
  wait "$pid"
  local rc=$?
  echo "[master] $(date +%H:%M:%S) task=$t pid=$pid exited rc=$rc"
}

echo "[master] $(date +%H:%M:%S) Phase 1+2 — ${#TASKS[@]} tasks sequentially"
for t in "${TASKS[@]}"; do
  run_task "$t"
done

# Verify
FAILED=0
for t in "${TASKS[@]}"; do
  safeT=$(echo "$t" | tr ':,.' '___')
  f="scripts/cache_bakeoff/r28v7_sl_${safeT}.jsonl"
  if [ ! -s "$f" ]; then
    echo "[master] FAIL: $f is empty"
    FAILED=$((FAILED + 1))
  else
    n=$(wc -l < "$f")
    echo "[master] OK: $f has $n lines"
  fi
done

if [ "$FAILED" -gt 0 ]; then
  echo "[master] Phase 1+2 failed (${FAILED} shards) — aborting"
  exit 1
fi

# Aggregator: extracts COMBO_SPEC if any per-asset pick is helpful
echo "[master] $(date +%H:%M:%S) Running aggregator (post Phase 1+2)"
COMBO_OUT=$(node --max-old-space-size=1500 --import tsx scripts/_r28V7SlSweepAggregate.ts 2>&1 | tee -a "$LOG_DIR/aggregate.log")
COMBO_SPEC=$(echo "$COMBO_OUT" | grep -E '^COMBO_SPEC=' | head -1 | sed 's/^COMBO_SPEC=//')

if [ -n "$COMBO_SPEC" ]; then
  echo "[master] $(date +%H:%M:%S) Phase 3 combo: spec=$COMBO_SPEC"
  run_task "combo:$COMBO_SPEC"
  echo "[master] $(date +%H:%M:%S) Re-aggregating with Phase 3 result"
  node --max-old-space-size=1500 --import tsx scripts/_r28V7SlSweepAggregate.ts 2>&1 | tee -a "$LOG_DIR/aggregate.log"
else
  echo "[master] $(date +%H:%M:%S) No Phase 3 combo recommended (no per-asset pick ≥+0.5pp)"
fi

printf "%s\n" "${ALL_PIDS[@]}" > "$LOG_DIR/pids.txt"
echo "[master] $(date +%H:%M:%S) ALL DONE"
