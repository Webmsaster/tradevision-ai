#!/bin/bash
# 2026-05-15 Combined Hunt — pruned Wave 1+2 into one sequential run with full CPU.
# threads=14 per sweep, no parallelism. 28 configs × 2 sweeps = 56 sweeps × ~55s = ~50 min.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/combined_results.tsv"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

# Default voter set = champion
VOTERS_CHAMP="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 1000 --step-days 1 --threads 14"

START_TS=$(date +%s)
COUNT=0
TOTAL_EXPECTED=28

run() {
  local label="$1"; local cfg="$2"; local voters="$3"
  shift 3
  COUNT=$((COUNT + 1))
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL_EXPECTED @ ${elapsed}s] $label"
  local p1=$($SWEEP $COMMON --config "$cfg" --profit-target 0.10 $voters "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$cfg" --profit-target 0.05 $voters "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# ===== SISTER CONFIGS at champion voters (8) =====
run "C01_amber-max-PL"   2h-trend-v5-amber-max-passlock         "$VOTERS_CHAMP"
run "C02_amber-PL"       2h-trend-v5-amber-passlock             "$VOTERS_CHAMP"
run "C03_amber-ext-PL"   2h-trend-v5-amber-ext-passlock         "$VOTERS_CHAMP"
run "C04_amber-quartz-PL" 2h-trend-v5-amber-quartz-passlock     "$VOTERS_CHAMP"
run "C05_amber-PL-daystg" 2h-trend-v5-amber-passlock-daystage   "$VOTERS_CHAMP"
run "C06_obsidian-PL"    2h-trend-v5-obsidian-passlock          "$VOTERS_CHAMP"
run "C07_titanium-PL"    2h-trend-v5-titanium-passlock          "$VOTERS_CHAMP"
run "C08_diamond-PL"     2h-trend-v5-diamond-passlock           "$VOTERS_CHAMP"

# ===== VOTER COMBOS at amber-max-passlock (12) =====
BASE="2h-trend-v5-amber-max-passlock"
run "V01_4V_no-HMM"     "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg"
run "V02_4V_no-FVG"     "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
run "V03_4V_no-SUPER"   "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-smc-fvg --regime-use-hmm"
run "V04_4V_no-BBZ"     "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
run "V05_4V_no-POCZ"    "$BASE" "--signals regime --regime-min-votes 2 --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
run "V06_5V_mv3"        "$BASE" "--signals regime --regime-min-votes 3 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
run "V07_6V_+CMF"       "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-cmf"
run "V08_6V_+KAL"       "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-kalman-trend"
run "V09_6V_+ARO"       "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-aroon"
run "V10_6V_+OFI"       "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-ofi"
run "V11_6V_+DBLTOP"    "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-double-top"
run "V12_6V_+RSI-HD"    "$BASE" "--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm --regime-use-rsi-hidden-div"

# ===== KEY TWEAKS at champion (8) =====
run "T01_tp=0.65"       "$BASE" "$VOTERS_CHAMP" --override-tp-mult 0.65
run "T02_tp=0.85"       "$BASE" "$VOTERS_CHAMP" --override-tp-mult 0.85
run "T03_tp=1.20"       "$BASE" "$VOTERS_CHAMP" --override-tp-mult 1.20
run "T04_drop=DOGE,RUNE" "$BASE" "$VOTERS_CHAMP" --drop-symbols "DOGEUSDT,RUNEUSDT"
run "T05_vc_vm=2.0"     "$BASE" "$VOTERS_CHAMP" --regime-vol-confirm --regime-vol-mult 2.0
run "T06_vc_vm=2.5"     "$BASE" "$VOTERS_CHAMP" --regime-vol-confirm --regime-vol-mult 2.5
run "T07_strict"        "$BASE" "$VOTERS_CHAMP" --strict-pass
run "T08_tp=0.65+drop"  "$BASE" "$VOTERS_CHAMP" --override-tp-mult 0.65 --drop-symbols "DOGEUSDT,RUNEUSDT"

echo ""
echo "=== TOP 15 by combined Funded ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -16
