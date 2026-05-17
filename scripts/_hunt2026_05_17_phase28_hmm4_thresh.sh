#!/bin/bash
# 2026-05-17 Phase 28 — HMM-4state Threshold Tuning.
# 4-state model spreads probability mass across more classes, so default
# (3-state) thresholds (0.55/0.55/0.20) may be too strict. Grid the
# bull/bear/opposite thresholds and measure Combined pass-rate impact.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
HMM_MODEL=models/hmm_4state_btc_30m.json
RESULTS="$OUT/phase28_hmm4_thresholds.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tp_bull\tp_bear\tp_opp\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; local pb="$2"; local pbr="$3"; local po="$4"
  echo "[$label p_bull=$pb p_bear=$pbr p_opp=$po]"
  local hmm_args="--hmm-model $HMM_MODEL --hmm-p-bull $pb --hmm-p-bear $pbr --hmm-p-opposite $po"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP $hmm_args 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP $hmm_args 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$pb\t$pbr\t$po\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Grid: lower thresholds = more HMM votes; higher = fewer but more confident
# 4-state model probability mass is split 4 ways, so 0.55 threshold is rarely hit
run "T01_p35_o20" 0.35 0.35 0.20
run "T02_p40_o20" 0.40 0.40 0.20
run "T03_p45_o20" 0.45 0.45 0.20
run "T04_p50_o20" 0.50 0.50 0.20
run "T05_p55_o20" 0.55 0.55 0.20  # = default
run "T06_p40_o30" 0.40 0.40 0.30
run "T07_p45_o30" 0.45 0.45 0.30
run "T08_p50_o30" 0.50 0.50 0.30
run "T09_p35_o25" 0.35 0.35 0.25
run "T10_asym_bullSlack" 0.40 0.50 0.20  # asymmetric: easier-long
run "T11_asym_bearSlack" 0.50 0.40 0.20  # asymmetric: easier-short

echo ""
echo "=== Phase 28 results (sorted by Combined desc) ==="
sort -t$'\t' -k7 -rn "$RESULTS" | head -15
