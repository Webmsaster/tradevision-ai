#!/usr/bin/env bash
# Grid-search: min-votes x voter-subset on champion AMBER_MAX_PASSLOCK + BNB 18/50 XA.
# Baseline: V02 (poc-z, bb-z-mr, supertrend, hmm, ad-line) min-votes=2 → 52.31% step=1d.
# Output TSV: name<TAB>min_votes<TAB>voters<TAB>pass_rate_pct
set -uo pipefail

REPO="/home/flooe/projects/tradevision-ai"
SWEEP="$REPO/engine-rust/target/release/ftmo-sweep"
CACHE="$REPO/scripts/cache_bakeoff"
OUT_DIR="$CACHE/minvotes_voter_grid_step1"
OUT_TSV="$OUT_DIR/results.tsv"
LOG_DIR="$OUT_DIR/logs"
mkdir -p "$LOG_DIR"

SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON=(
  --candles-dir "$CACHE"
  --funding-dir "$CACHE"
  --symbols "$SYMS"
  --windows 9999
  --threads 2
  --profit-target 0.10
  --max-days 30
  --signals regime
  --cross-asset-sym BNBUSDT
  --cross-asset-fast 18
  --cross-asset-slow 50
  --config 2h-trend-v5-amber-max-passlock
  --override-tp-mult 1.10
  --kelly-sizing
  --kelly-fraction 0.5
  --kelly-window 60
  --kelly-min-trades 20
  --strict-pass
)

# Voter-subset definitions
V5_BASE="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
V4_NO_AD="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
V4_NO_HMM="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-ad-line"
V4_NO_BBZ="--regime-poc-z --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
V6_KAMA="$V5_BASE --regime-use-kama"
V6_ICHI="$V5_BASE --regime-use-ichimoku"

echo -e "name\tmin_votes\tstep_days\tvoters\tpass_rate_pct" > "$OUT_TSV"

run_one() {
  local name="$1" mv="$2" step="$3" voters="$4"
  local log="$LOG_DIR/${name}_mv${mv}_step${step}.log"
  echo "[$(date +%H:%M:%S)] running $name mv=$mv step=${step}d ..."
  # shellcheck disable=SC2086
  "$SWEEP" "${COMMON[@]}" --step-days "$step" --regime-min-votes "$mv" $voters > "$log" 2>&1
  local pct
  pct=$(grep -oE '[0-9]+\.[0-9]+%' "$log" | tail -1 | tr -d '%')
  if [[ -z "$pct" ]]; then pct="NA"; fi
  echo -e "${name}\t${mv}\t${step}\t${voters}\t${pct}" >> "$OUT_TSV"
  echo "  -> $pct%"
}

# === Grid stage: step=3d ===
for MV in 2 3 4; do
  run_one "V5_base"      "$MV" 3 "$V5_BASE"
  run_one "V4_no_adline" "$MV" 3 "$V4_NO_AD"
  run_one "V4_no_hmm"    "$MV" 3 "$V4_NO_HMM"
  run_one "V4_no_bbz"    "$MV" 3 "$V4_NO_BBZ"
  run_one "V6_kama"      "$MV" 3 "$V6_KAMA"
  run_one "V6_ichimoku"  "$MV" 3 "$V6_ICHI"
done

echo ""
echo "=== Grid (step=3d) complete. Sorting top-3 for step=1d validation... ==="
# Top-3 by pct (skip header). Filter NA. Also clip mv<=#voters (else 0% trivially).
TOP3=$(tail -n +2 "$OUT_TSV" | awk -F'\t' '$5!="NA"' | sort -t $'\t' -k5,5 -gr | head -3)
echo "$TOP3"

echo ""
echo "=== Re-validating top-3 at step=1d ==="
while IFS=$'\t' read -r name mv step voters pct; do
  run_one "${name}_VALIDATE" "$mv" 1 "$voters"
done <<< "$TOP3"

echo ""
echo "=== ALL RESULTS (sorted desc) ==="
{ head -1 "$OUT_TSV"; tail -n +2 "$OUT_TSV" | sort -t $'\t' -k5,5 -gr; } | column -t -s $'\t'
