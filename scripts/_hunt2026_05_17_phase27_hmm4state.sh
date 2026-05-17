#!/bin/bash
# 2026-05-17 Phase 27 — HMM-4state Model Wireup Test.
# Tests whether passing the trained 4-state HMM model (sideways/bull/bear/crash)
# beats the hardcoded 3-state default (bear/range/bull) on AMBER_MAX_PASSLOCK champion.
#
# Champion baseline (Phase 25 script, NO --hmm-model):
#   2h-trend-v5-amber-max-passlock + tp_mult 1.14 + Kelly w60/min20/0.5
#   V02 voters: min-votes 2 + poc-z + bb-z-mr + supertrend + use-hmm + ad-line
#   BTC cross-asset filter
#
# Phase 27 adds: --hmm-model models/hmm_4state_btc_30m.json
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
HMM_MODEL=models/hmm_4state_btc_30m.json
RESULTS="$OUT/phase27_hmm4state.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# A) Baseline (3-state default model)
run "A_baseline_3state"

# B) 4-state model (different feature space + 4 regime classes)
run "B_hmm4state_default_thresh" --hmm-model "$HMM_MODEL"

# C) 4-state with slightly relaxed thresholds (more votes from voter)
# Note: HmmRegimeParams thresholds aren't sweep-exposed yet — placeholder
# row C currently identical to B, included for slot reservation.

# D) 4-state + tp_mult 1.16 (compensate if more votes lead to more drawdown)
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.16 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
run "D_hmm4state_tp1.16" --hmm-model "$HMM_MODEL"

# E) 4-state + Kelly w100/min30 (memory champion variant)
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 100 --kelly-min-trades 30"
run "E_hmm4state_kelly_w100_m30" --hmm-model "$HMM_MODEL"

echo ""
echo "=== Phase 27 results (sorted by Combined desc) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head
