#!/bin/bash
# 2026-05-17 Phase 31 — 2-voter combos of Phase 30 winners.
# Reads phase30 results, picks top-3 voters with Combined > baseline,
# tests all 2-voter combos plus tp_mult micro-sweep around 1.14.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
PHASE30_TSV="$OUT/phase30_pre25_voters.tsv"
RESULTS="$OUT/phase31_pre25_combos.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\ttp_mult\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"

declare -A VOTER_FLAG=(
  ["K01_+kalman_trend"]="--regime-use-kalman-trend"
  ["K02_+aroon"]="--regime-use-aroon"
  ["K03_+cmf"]="--regime-use-cmf"
  ["K04_+ofi"]="--regime-use-ofi"
  ["K05_+smc_fvg"]="--regime-use-smc-fvg"
  ["K06_+rsi_hidden_div"]="--regime-use-rsi-hidden-div"
  ["K07_+vwap_trend"]="--regime-vwap-trend"
  ["K08_+stop_hunt"]="--regime-stophunt"
  ["K09_+double_top"]="--regime-use-double-top"
  ["K10_+cme_basis"]="--regime-use-cme-basis"
  ["K11_+top_trader_ls"]="--regime-use-top-trader-ls"
  ["K12_+nupl"]="--regime-use-nupl"
  ["K13_+cb_premium"]="--regime-use-cb-premium"
  ["K14_+stablecoin"]="--regime-use-stablecoin"
)

# Get baseline combined
BASELINE=$(awk -F'\t' '$1=="Z00_champion"{print $4; exit}' "$PHASE30_TSV")
echo "[ref] Z00_champion baseline Combined=$BASELINE"

# Pick top-3 voters with Combined > baseline
mapfile -t TOPVOTERS < <(
  awk -v base="$BASELINE" -F'\t' '
    NR>1 && $1 ~ /^K[0-9]+_/ && ($4+0) > (base+0) {
      printf "%s\t%s\n", $4, $1
    }' "$PHASE30_TSV" | sort -rn | head -3 | awk -F'\t' '{print $2}'
)

if [ ${#TOPVOTERS[@]} -eq 0 ]; then
  echo "[no-winners] No Phase-30 voter beat baseline. Phase 31 skipped (pure tp-mult sweep instead)."
  CHAMP="--config 2h-trend-v5-amber-max-passlock --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
  for tp in 1.05 1.08 1.10 1.12 1.14 1.16 1.18 1.22; do
    echo "[tp_only_$tp]"
    p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP --override-tp-mult "$tp" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP --override-tp-mult "$tp" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    [ -z "$p1" ] || [ -z "$p2" ] && continue
    c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
    echo -e "tp_only_$tp\t$tp\t$p1\t$p2\t$c" | tee -a "$RESULTS"
  done
  echo ""
  echo "=== Phase 31 fallback tp-only sweep ==="
  sort -t$'\t' -k5 -rn "$RESULTS"
  exit 0
fi

echo "[topvoters] ${TOPVOTERS[@]}"

CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

run() {
  local label="$1"; local tpm="$2"; shift 2
  echo "[$label tp=$tpm]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && { echo "[skip-empty] $label"; return; }
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$tpm\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Single-voter tp_mult sweep on each winner
for v in "${TOPVOTERS[@]}"; do
  flag=${VOTER_FLAG[$v]:-}
  [ -z "$flag" ] && continue
  for tp in 1.10 1.14 1.18; do
    CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult $tp --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
    p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP $flag 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP $flag 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
    [ -z "$p1" ] || [ -z "$p2" ] && continue
    c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
    echo -e "${v}_tp${tp}\t$tp\t$p1\t$p2\t$c" | tee -a "$RESULTS"
  done
done

# 2-voter additive combos
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
n=${#TOPVOTERS[@]}
for ((i=0;i<n;i++)); do
  for ((j=i+1;j<n;j++)); do
    v1=${TOPVOTERS[i]}; v2=${TOPVOTERS[j]}
    f1=${VOTER_FLAG[$v1]:-}; f2=${VOTER_FLAG[$v2]:-}
    [ -z "$f1" ] || [ -z "$f2" ] && continue
    for tp in 1.12 1.14 1.16; do
      label="${v1}+${v2}_tp${tp}"
      CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult $tp --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
      p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP $f1 $f2 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
      p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP $f1 $f2 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
      [ -z "$p1" ] || [ -z "$p2" ] && continue
      c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
      echo -e "$label\t$tp\t$p1\t$p2\t$c" | tee -a "$RESULTS"
    done
  done
done

echo ""
echo "=== Phase 31 results (sorted by Combined desc) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -15
