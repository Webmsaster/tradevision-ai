#!/bin/bash
# 2026-05-17 Phase 26 — Lever-Hunt around Phase-25 best voters.
# Usage:
#   bash scripts/_hunt2026_05_17_phase26_additive_lever.sh "--regime-use-X --regime-use-Y"
# Reads Phase-25 TSV, takes top-3 voters by Combined, generates 2-voter
# additive combos, then sweeps tp_mult {1.10, 1.12, 1.14, 1.16, 1.18}
# around each combo. Plus a "baseline" no-extra-voter row for reference.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
PHASE25_TSV="$OUT/phase25_new_voters.tsv"
RESULTS="$OUT/phase26_additive_lever.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\ttp_mult\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP="--config 2h-trend-v5-amber-max-passlock --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"

# Voter-flag map (Phase-25 label → CLI flag)
declare -A VOTER_FLAG=(
  ["N01_+squeeze"]="--regime-use-squeeze"
  ["N02_+hurst"]="--regime-use-hurst"
  ["N03_+wavelet"]="--regime-use-wavelet"
  ["N04_+pivot"]="--regime-use-pivot"
  ["N05_+fib"]="--regime-use-fib"
  ["N06_+vah_val"]="--regime-use-vah-val"
  ["N07_+ichimoku"]="--regime-use-ichimoku"
  ["N08_+arima"]="--regime-use-arima"
  ["N09_+garch_gate"]="--regime-use-garch-gate"
  ["N10_+bocpd_gate"]="--regime-use-bocpd-gate"
  ["N11_+kama"]="--regime-use-kama"
  ["N12_+fisher"]="--regime-use-fisher"
)

# Get baseline combined from N00_champion line
BASELINE=$(awk -F'\t' '$1=="N00_champion"{print $4; exit}' "$PHASE25_TSV")
echo "[ref] N00_champion baseline Combined=$BASELINE"

# Pick top-3 single voters where Combined > baseline (winners only)
mapfile -t TOPVOTERS < <(
  awk -v base="$BASELINE" -F'\t' '
    NR>1 && $1 ~ /^N(0[1-9]|1[0-2])_/ && ($4+0) > (base+0) {
      printf "%s\t%s\n", $4, $1
    }' "$PHASE25_TSV" | sort -rn | head -3 | awk -F'\t' '{print $2}'
)

if [ ${#TOPVOTERS[@]} -eq 0 ]; then
  echo "[no-winners] No Phase-25 voter beat baseline. Lever-hunt on baseline only."
fi

run() {
  local label="$1"; shift
  local tpm="$1"; shift
  echo "[$label tp=$tpm]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP --override-tp-mult "$tpm" "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP --override-tp-mult "$tpm" "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$tpm\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# tp_mult grid on baseline (no extra voters)
for tp in 1.10 1.12 1.14 1.16 1.18; do
  run "baseline" "$tp"
done

# tp_mult grid on each Top-1 voter
for v in "${TOPVOTERS[@]}"; do
  flag="${VOTER_FLAG[$v]:-}"
  [ -z "$flag" ] && continue
  for tp in 1.10 1.14 1.18; do
    run "$v" "$tp" $flag
  done
done

# 2-voter additive combos (top-3 → 3 pairs)
n=${#TOPVOTERS[@]}
if [ $n -ge 2 ]; then
  for ((i=0;i<n;i++)); do
    for ((j=i+1;j<n;j++)); do
      v1=${TOPVOTERS[i]}; v2=${TOPVOTERS[j]}
      f1=${VOTER_FLAG[$v1]:-}; f2=${VOTER_FLAG[$v2]:-}
      [ -z "$f1" ] || [ -z "$f2" ] && continue
      for tp in 1.12 1.14 1.16; do
        run "${v1}+${v2}" "$tp" $f1 $f2
      done
    done
  done
fi

echo ""
echo "=== Phase 26 results (sorted by Combined desc) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -15
