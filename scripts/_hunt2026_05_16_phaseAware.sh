#!/bin/bash
# 2026-05-16 Phase-Aware P2 Hunt — test P2-specific tweaks at champion P1.
# Hypothesis: P2 (5% target) benefits from lower risk + longer hold-bars (STEP2-style).
# Baseline V02 single-phase: P1=49.60, P2=59.70, Combined=29.61.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS_P2="$OUT/phaseaware_p2.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS_P2" ]; then
  : > "$RESULTS_P2"
  echo -e "p2_label\tP2_pct\tcombined_if_P1_49.6" >> "$RESULTS_P2"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BASE_CFG="2h-trend-v5-amber-max-passlock"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 14"
P1_BASELINE=49.60

START_TS=$(date +%s)
COUNT=0
TOTAL=18

run_p2() {
  local label="$1"; shift
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS_P2" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"
    return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s] $label"
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$P1_BASELINE" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p2\t$combined" | tee -a "$RESULTS_P2"
}

# ===== P2 Risk-Halving =====
run_p2 "P2_lev0.5"              --override-leverage 0.5
run_p2 "P2_lev0.6"              --override-leverage 0.6
run_p2 "P2_lev0.7"              --override-leverage 0.7
run_p2 "P2_lev0.8"              --override-leverage 0.8

# ===== P2 Hold-Bars STEP2-style =====
run_p2 "P2_hold300"             --override-hold-bars 300
run_p2 "P2_hold500"             --override-hold-bars 500
run_p2 "P2_hold720"             --override-hold-bars 720

# ===== P2 Tight TP =====
run_p2 "P2_tp0.5"               --override-tp-mult 0.5
run_p2 "P2_tp0.7"               --override-tp-mult 0.7
run_p2 "P2_tp0.85"              --override-tp-mult 0.85

# ===== P2 Tight Stop =====
run_p2 "P2_stop0.03"            --override-stop-pct 0.03
run_p2 "P2_stop0.025"           --override-stop-pct 0.025

# ===== P2 Min-trading-days extend =====
run_p2 "P2_mtd5"                --min-trading-days 5
run_p2 "P2_mtd6"                --min-trading-days 6

# ===== P2 Combined STEP2 = risk0.5 + hold500 =====
run_p2 "P2_step2_combo1"        --override-leverage 0.5 --override-hold-bars 300
run_p2 "P2_step2_combo2"        --override-leverage 0.6 --override-hold-bars 500
run_p2 "P2_step2_combo3"        --override-leverage 0.5 --override-hold-bars 500 --override-tp-mult 0.7
run_p2 "P2_step2_combo4"        --override-leverage 0.7 --override-hold-bars 300 --override-tp-mult 0.85

echo ""
echo "=== TOP 10 P2 results ==="
sort -t$'\t' -k2 -rn "$RESULTS_P2" | head -11
