#!/bin/bash
# 2026-05-16 Phase 13 — Step-2 SEPARATE Optimization (Hunt 49 idea).
# P1 fixed = champion, P2 sweeps tp_mult × max_days.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase13_step2sep.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tp1_static\tp2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"

# P1 ist STATISCH = Champion 55.62% (we won't re-run it 32× — cache it)
P1_STATIC=55.62

run_p2_only() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $KELLY "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$P1_STATIC" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$P1_STATIC\t$p2\t$c" | tee -a "$RESULTS"
}

# Reach-First: tighter tp + longer max_days
run_p2_only "S00_baseline_1.14_45"   --override-tp-mult 1.14 --max-days 45
run_p2_only "S01_tp_0.70_md_45"      --override-tp-mult 0.70 --max-days 45
run_p2_only "S02_tp_0.80_md_45"      --override-tp-mult 0.80 --max-days 45
run_p2_only "S03_tp_0.85_md_45"      --override-tp-mult 0.85 --max-days 45
run_p2_only "S04_tp_0.90_md_45"      --override-tp-mult 0.90 --max-days 45
run_p2_only "S05_tp_0.95_md_45"      --override-tp-mult 0.95 --max-days 45
run_p2_only "S06_tp_1.00_md_45"      --override-tp-mult 1.00 --max-days 45
run_p2_only "S07_tp_1.05_md_45"      --override-tp-mult 1.05 --max-days 45

run_p2_only "S08_tp_0.85_md_60"      --override-tp-mult 0.85 --max-days 60
run_p2_only "S09_tp_0.90_md_60"      --override-tp-mult 0.90 --max-days 60
run_p2_only "S10_tp_0.95_md_60"      --override-tp-mult 0.95 --max-days 60
run_p2_only "S11_tp_1.00_md_60"      --override-tp-mult 1.00 --max-days 60
run_p2_only "S12_tp_1.14_md_60"      --override-tp-mult 1.14 --max-days 60

run_p2_only "S13_tp_0.90_md_50"      --override-tp-mult 0.90 --max-days 50
run_p2_only "S14_tp_0.85_md_55"      --override-tp-mult 0.85 --max-days 55
run_p2_only "S15_tp_0.80_md_60"      --override-tp-mult 0.80 --max-days 60

echo ""
echo "=== Phase 13 Step-2 SEPARATE results (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -20
