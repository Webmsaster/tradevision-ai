#!/bin/bash
# 2026-05-19 cluster-only-mode evaluation: baseline vs 3 cluster-only variants.
# Tests whether applying the live-cluster gate to EVERY signal (not just
# start-gate) HELPS or HURTS pass-rate on AMBER_MAX_PASSLOCK champion.
set -euo pipefail

cd /home/flooe/projects/tradevision-ai
WT=/home/flooe/projects/tradevision-ai/.claude/worktrees/agent-a9545d1abe88577cc
SWEEP="$WT/engine-rust/target/release/ftmo-sweep"
OUT_DIR="$WT/scripts/cluster_only_eval_2026_05_19"
mkdir -p "$OUT_DIR"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

# Use a fast-but-statistically-meaningful slice: 200 windows step 5d ≈ 2.74y span.
WINDOWS=200
STEP=5

common_args=(
  --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff
  --symbols "$SYMBOLS" --windows "$WINDOWS" --step-days "$STEP" --threads 8
  --profit-target 0.10 --max-days 30
  --signals regime --regime-min-votes 2
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend
  --regime-use-hmm --regime-use-ad-line
  --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21
  --config 2h-trend-v5-amber-max-passlock
  --override-tp-mult 1.40
  --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20
  --ptp-levels "0.08:0.25"
  --strict-pass
  --initial-window-hours 24
  --majors-list BTC,ETH,BNB,SOL
)

run_one() {
  local label="$1"; shift
  local out="$OUT_DIR/$label.jsonl"
  echo "=== Running: $label ==="
  echo "Flags (extras): $*"
  "$SWEEP" "${common_args[@]}" --out "$out" "$@" 2>&1 | tail -20
  # Pass-rate calc: passed-true / total.
  local passed total pct
  passed=$(grep -c '"passed":true' "$out" || true)
  total=$(grep -c '"win_idx":' "$out" || true)
  if [[ "$total" -gt 0 ]]; then
    pct=$(awk -v p="$passed" -v t="$total" 'BEGIN { printf "%.2f", 100.0 * p / t }')
  else
    pct="n/a"
  fi
  echo "[$label] passed=$passed total=$total pass_rate=${pct}%"
  printf "%-40s\t%s\t%s\t%s\n" "$label" "$passed" "$total" "${pct}%" >> "$OUT_DIR/summary.tsv"
}

> "$OUT_DIR/summary.tsv"
printf "%-40s\t%s\t%s\t%s\n" "label" "passed" "total" "pass_rate" >> "$OUT_DIR/summary.tsv"

# Baseline: start-gate inactive, cluster-only inactive.
run_one "baseline_no_gate"

# Baseline + start-gate b=4 m=3 (current production gate) for reference.
run_one "baseline_startgate_b4_m3" \
  --min-initial-signal-breadth 4 --min-initial-majors 3

# Cluster-only-mode variants.
run_one "cluster_only_b10_m2" \
  --cluster-only-mode \
  --min-initial-signal-breadth 10 --min-initial-majors 2

run_one "cluster_only_b9_m2" \
  --cluster-only-mode \
  --min-initial-signal-breadth 9 --min-initial-majors 2

run_one "cluster_only_b6_m4_tier_s" \
  --cluster-only-mode \
  --min-initial-signal-breadth 6 --min-initial-majors 4

echo "=== Summary ==="
cat "$OUT_DIR/summary.tsv"
