#!/bin/bash
# 2026-05-16 Phase 20 — Voter-Subset systematic search ON champion stack.
# Goal: find a 6-7 voter combination that beats current 5-voter setup.
# Aus Arch-3 (Multi-strategy ensemble) + Arch-4 (Regime-adaptive).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase20_voter_combos.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

V02_BASE="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
CHAMP="--override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --max-days 45"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $V02_BASE $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $V02_BASE $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

run "W00_champion_5voters"

# Add one extra voter (single-add Tests, mv=2)
run "W01_+aroon"              --regime-use-aroon
run "W02_+cmf"                --regime-use-cmf
run "W03_+nupl"               --regime-use-nupl
run "W04_+double_top"         --regime-use-double-top
run "W05_+kalman"             --regime-use-kalman-trend
run "W06_+ofi"                --regime-use-ofi
run "W07_+rsi_hd"             --regime-use-rsi-hidden-div
run "W08_+smc_fvg"            --regime-use-smc-fvg
run "W09_+top_trader"         --regime-use-top-trader-ls
run "W10_+stablecoin"         --regime-use-stablecoin
run "W11_+cb_premium"         --regime-use-cb-premium

# Add 2 extras simultaneously (paired-add Tests, mv=2)
run "W12_+cmf+nupl"           --regime-use-cmf --regime-use-nupl
run "W13_+aroon+cmf"          --regime-use-aroon --regime-use-cmf
run "W14_+double_top+nupl"    --regime-use-double-top --regime-use-nupl
run "W15_+kalman+aroon"       --regime-use-kalman-trend --regime-use-aroon
run "W16_+ofi+cmf"            --regime-use-ofi --regime-use-cmf
run "W17_+rsi_hd+nupl"        --regime-use-rsi-hidden-div --regime-use-nupl
run "W18_+aroon+rsi_hd"       --regime-use-aroon --regime-use-rsi-hidden-div

# Min-votes 3 mit erweiterten Voter-Set
run "W19_mv3_+cmf+nupl"       --regime-use-cmf --regime-use-nupl --regime-min-votes 3
run "W20_mv3_+aroon+cmf+nupl" --regime-use-aroon --regime-use-cmf --regime-use-nupl --regime-min-votes 3
run "W21_mv3_all_pure_price"  --regime-use-aroon --regime-use-cmf --regime-use-nupl --regime-use-kalman-trend --regime-min-votes 3
run "W22_mv4_all_pure_price"  --regime-use-aroon --regime-use-cmf --regime-use-nupl --regime-use-kalman-trend --regime-min-votes 4

# Remove voter from baseline (test of dead-weight)
run "W23_minus_hmm"           --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-ad-line
run "W24_minus_supertrend"    --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-hmm --regime-use-ad-line
run "W25_minus_bb_z_mr"       --signals regime --regime-min-votes 2 --regime-poc-z --regime-use-supertrend --regime-use-hmm --regime-use-ad-line
run "W26_minus_poc_z"         --signals regime --regime-min-votes 2 --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line
run "W27_minus_ad_line"       --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm

echo ""
echo "=== Phase 20 Voter-Subset results (top 15) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -20
