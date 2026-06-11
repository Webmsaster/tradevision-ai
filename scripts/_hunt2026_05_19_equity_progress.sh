#!/bin/bash
# 2026-05-19 Research: Equity-Progress Sizing Sweep (step=1d / 1019 windows).
#
# Hypothesis: scaling DOWN risk once equity is close to profit-target may
# "lock the win" — avoid round-trip give-back near the line.
#
# CLI flags (sweep.rs):
#   --ds-progress-frac <F>    trigger when (equity-1) >= profit_target * F
#   --ds-progress-factor <X>  cap-down sizing factor when triggered
#
# Mechanism is CAP-DOWN ONLY (never raises factor). Lookahead-safe — only
# realized PnL counts. See engine-rust/ftmo-engine-core/src/sizing.rs:58-74.
#
# Champion baseline (Round 28+) — AMBER_MAX_PASSLOCK with V02 regime + BTC cross-asset.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/equity_progress_hunt
RESULTS="$OUT/equity_progress_results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
# step=1d / windows=1019 per user mandate (full coverage).
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 1019 --step-days 1 --threads 4"
CHAMP_P1="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.40 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"
CHAMP_P2="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1
  p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP_P1 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2
  p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP_P2 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c
  c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# A) Baseline — no equity scaling (current champion).
run "A_baseline_no_equity_scaling"

# Per user-spec:
# B) progress 50% → 0.5× sizing
run "B_progress_50_f0.5" --ds-progress-frac 0.5 --ds-progress-factor 0.5

# C) progress 80% → 0.3× sizing
run "C_progress_80_f0.3" --ds-progress-frac 0.8 --ds-progress-factor 0.3

# D) progress 80% → 0.5× sizing (less aggressive cap at the same trigger).
run "D_progress_80_f0.5" --ds-progress-frac 0.8 --ds-progress-factor 0.5

# E) progress 70% → 0.5× (between 50% and 80% trigger).
run "E_progress_70_f0.5" --ds-progress-frac 0.7 --ds-progress-factor 0.5

# F) progress 90% → 0.3× — only very-near-target cap.
run "F_progress_90_f0.3" --ds-progress-frac 0.9 --ds-progress-factor 0.3

# G) progress 50% → 0.3× — strong early defense.
run "G_progress_50_f0.3" --ds-progress-frac 0.5 --ds-progress-factor 0.3

echo ""
echo "=== Equity-Progress sweep (step=1d, n=1019 windows) — sorted by Combined desc ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -10
