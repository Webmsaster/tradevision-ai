#!/usr/bin/env bash
# Kelly hyperparameter grid sweep — 2026-05-19
# Champion: --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 → 50.00%
# Goal: find combo that beats 50%
set -u
cd "$(dirname "$0")/.."
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT_DIR="scripts/cache_bakeoff/kelly_hunt"
RESULTS="$OUT_DIR/kelly_grid_results.tsv"
mkdir -p "$OUT_DIR"
: > "$RESULTS"
echo -e "label\tfraction\twindow\tmin_trades\tpassed\ttotal\tpass_pct\telapsed_s" >> "$RESULTS"

run_sweep() {
  local label="$1"
  local kelly_args="$2"
  local start=$(date +%s)
  local logf="$OUT_DIR/${label}.log"
  ./engine-rust/target/release/ftmo-sweep \
    --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
    --symbols "$SYMBOLS" --windows 334 --step-days 7 --threads 8 \
    --profit-target 0.10 --max-days 30 \
    --signals regime --regime-min-votes 2 \
    --regime-poc-z --regime-bb-z-mr --regime-use-supertrend \
    --regime-use-hmm --regime-use-ad-line \
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 \
    --config 2h-trend-v5-amber-max-passlock \
    --override-tp-mult 1.10 \
    $kelly_args \
    --strict-pass \
    --out "$OUT_DIR/${label}.jsonl" > "$logf" 2>&1
  local end=$(date +%s)
  local elapsed=$((end-start))
  local pass_line
  pass_line=$(grep -E "^passed=" "$logf" | tail -1)
  echo "[done] $label : $pass_line (${elapsed}s)"
  # parse "passed=73 / 146 (50.00%)"
  local p=$(echo "$pass_line" | sed -E 's/passed=([0-9]+) \/ ([0-9]+) \(([0-9.]+)%\).*/\1\t\2\t\3/')
  local f=$(echo "$label" | sed -E 's/k_([0-9.]+)_w([0-9]+)_m([0-9]+)/\1\t\2\t\3/')
  if [[ "$label" == "no_kelly" ]]; then
    f="-\t-\t-"
  fi
  echo -e "${label}\t${f}\t${p}\t${elapsed}" >> "$RESULTS"
}

# ── PHASE 1: focused grid around champion (0.5/60/20 = baseline)
# Vary fraction (keep w=60, m=20)
run_sweep "k_0.25_w60_m20" "--kelly-sizing --kelly-fraction 0.25 --kelly-window 60 --kelly-min-trades 20"
run_sweep "k_0.40_w60_m20" "--kelly-sizing --kelly-fraction 0.40 --kelly-window 60 --kelly-min-trades 20"
run_sweep "k_0.60_w60_m20" "--kelly-sizing --kelly-fraction 0.60 --kelly-window 60 --kelly-min-trades 20"
run_sweep "k_0.75_w60_m20" "--kelly-sizing --kelly-fraction 0.75 --kelly-window 60 --kelly-min-trades 20"
run_sweep "k_1.00_w60_m20" "--kelly-sizing --kelly-fraction 1.00 --kelly-window 60 --kelly-min-trades 20"

# Vary window (keep f=0.5, m=20)
run_sweep "k_0.50_w40_m20" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 40 --kelly-min-trades 20"
run_sweep "k_0.50_w80_m20" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 80 --kelly-min-trades 20"
run_sweep "k_0.50_w100_m20" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 100 --kelly-min-trades 20"
run_sweep "k_0.50_w120_m20" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 120 --kelly-min-trades 20"
run_sweep "k_0.50_w150_m20" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 150 --kelly-min-trades 20"

# Vary min-trades (keep f=0.5, w=60)
run_sweep "k_0.50_w60_m10" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 60 --kelly-min-trades 10"
run_sweep "k_0.50_w60_m30" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 60 --kelly-min-trades 30"
run_sweep "k_0.50_w60_m50" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 60 --kelly-min-trades 50"

# Memory's mentioned winner — w100/m30 with different fractions
run_sweep "k_0.50_w100_m30" "--kelly-sizing --kelly-fraction 0.50 --kelly-window 100 --kelly-min-trades 30"
run_sweep "k_0.40_w100_m30" "--kelly-sizing --kelly-fraction 0.40 --kelly-window 100 --kelly-min-trades 30"
run_sweep "k_0.60_w100_m30" "--kelly-sizing --kelly-fraction 0.60 --kelly-window 100 --kelly-min-trades 30"
run_sweep "k_0.75_w100_m30" "--kelly-sizing --kelly-fraction 0.75 --kelly-window 100 --kelly-min-trades 30"

# Aggressive corners
run_sweep "k_0.25_w40_m10" "--kelly-sizing --kelly-fraction 0.25 --kelly-window 40 --kelly-min-trades 10"
run_sweep "k_1.00_w150_m50" "--kelly-sizing --kelly-fraction 1.00 --kelly-window 150 --kelly-min-trades 50"

# Kelly disabled
run_sweep "no_kelly" ""

echo "[ALL DONE]"
echo "Results: $RESULTS"
sort -t$'\t' -k7,7 -n -r "$RESULTS" | head -10
