#!/bin/bash
# 2026-05-16 Phase 11 — Funding filters + adaptive_tp + min_days + lscool +
# pdd + dpts + idl + step-days variations on champion (X03 36.82).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase11_unexplored.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"
ADLINE="--regime-use-ad-line"
CHAMP="--override-tp-mult 1.14 $KELLY $ADLINE"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER --step-days 3 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER --step-days 3 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# U00 champion replicate
run "U00_champion"          $CHAMP

# Funding-rate filters (entry-block based on extreme funding)
run "U01_fund_maxL_0.01"    $CHAMP --funding-max-long 0.01
run "U02_fund_maxL_0.005"   $CHAMP --funding-max-long 0.005
run "U03_fund_minS_-0.005"  $CHAMP --funding-min-short -0.005
run "U04_fund_minS_-0.01"   $CHAMP --funding-min-short -0.01
run "U05_fund_both"         $CHAMP --funding-max-long 0.01 --funding-min-short -0.01

# Funding-cost sizing (alpha down-scale)
run "U06_fund_size_default" $CHAMP --funding-sizing-alpha 1.0
run "U07_fund_size_alpha_2" $CHAMP --funding-sizing-alpha 2.0
run "U08_fund_size_alpha_5" $CHAMP --funding-sizing-alpha 5.0

# Adaptive-TP variations
run "U09_adapt_static"      $CHAMP --adaptive-tp static
run "U10_adapt_atr"         $CHAMP --adaptive-tp atr
run "U11_adapt_vol_high"    $CHAMP --adaptive-tp vol-high
run "U12_adapt_vol_norm"    $CHAMP --adaptive-tp vol-norm

# min_trading_days
run "U13_mtd_3"             $CHAMP --min-trading-days 3
run "U14_mtd_5"             $CHAMP --min-trading-days 5
run "U15_mtd_6"             $CHAMP --min-trading-days 6

# max_days variation
run "U16_max_days_45"       $CHAMP --max-days 45
run "U17_max_days_90"       $CHAMP --max-days 90
run "U18_max_days_60"       $CHAMP --max-days 60

# lscool (lookback shorter cooldown)
run "U19_lscool_after_3"    $CHAMP --lscool-after 3 --lscool-bars 12
run "U20_lscool_after_5"    $CHAMP --lscool-after 5 --lscool-bars 24

# pdd / dpts / cpts / idl modulation
run "U21_pdd_70_0.5"        $CHAMP --pdd-from-peak 0.70 --pdd-factor 0.5
run "U22_pdd_80_0.7"        $CHAMP --pdd-from-peak 0.80 --pdd-factor 0.7
run "U23_dpts_0.7"          $CHAMP --dpts-trail 0.7
run "U24_cpts_0.7"          $CHAMP --cpts-trail 0.7
run "U25_idl_0.05_0.5"      $CHAMP --idl-threshold 0.05 --idl-factor 0.5

echo ""
echo "=== Phase 11 results (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -20
