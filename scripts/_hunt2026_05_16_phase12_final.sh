#!/bin/bash
# 2026-05-16 Phase 12 — Max-days feinsweep + symbol-mix experiments.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase12_final.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"
ADLINE="--regime-use-ad-line"
CHAMP="--override-tp-mult 1.14 $KELLY $ADLINE"

run() {
  local label="$1"; local syms="$2"; shift 2
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --symbols "$syms" --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --symbols "$syms" --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Z00 champion replicate
run "Z00_champion" "$SYMS_19" $CHAMP --max-days 45

# max-days feinsweep
run "Z01_md_30"   "$SYMS_19" $CHAMP --max-days 30
run "Z02_md_35"   "$SYMS_19" $CHAMP --max-days 35
run "Z03_md_40"   "$SYMS_19" $CHAMP --max-days 40
run "Z04_md_42"   "$SYMS_19" $CHAMP --max-days 42
run "Z05_md_44"   "$SYMS_19" $CHAMP --max-days 44
run "Z06_md_46"   "$SYMS_19" $CHAMP --max-days 46
run "Z07_md_48"   "$SYMS_19" $CHAMP --max-days 48
run "Z08_md_50"   "$SYMS_19" $CHAMP --max-days 50
run "Z09_md_55"   "$SYMS_19" $CHAMP --max-days 55

# Symbol mix combinations (mit champion config + md 45)
ALL24="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOGEUSDT,DOTUSDT,ETCUSDT,ETHUSDT,INJUSDT,LINKUSDT,LTCUSDT,NEARUSDT,RUNEUSDT,SANDUSDT,SOLUSDT,STXUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
run "Z10_sym20_DOGE"  "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOGEUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT" $CHAMP --max-days 45
run "Z11_sym20_STX"   "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,STXUSDT,TRXUSDT,UNIUSDT,XRPUSDT" $CHAMP --max-days 45
run "Z12_sym21_DOGE_STX" "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOGEUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,STXUSDT,TRXUSDT,UNIUSDT,XRPUSDT" $CHAMP --max-days 45
run "Z13_sym24_full" "$ALL24" $CHAMP --max-days 45

# Profit-target experiments (different from 0.10/0.05)
echo "[Z14_pt_0.08_0.04]"
P1=$($SWEEP $COMMON --symbols "$SYMS_19" --config "$BASE_CFG" --profit-target 0.08 $VOTERS_V02 $BTC_FILTER $CHAMP --max-days 45 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
P2=$($SWEEP $COMMON --symbols "$SYMS_19" --config "$BASE_CFG" --profit-target 0.04 $VOTERS_V02 $BTC_FILTER $CHAMP --max-days 45 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
C=$(awk -v a="$P1" -v b="$P2" 'BEGIN{printf "%.2f", a*b/100}')
echo -e "Z14_pt_0.08_0.04\t$P1\t$P2\t$C" | tee -a "$RESULTS"

echo "[Z15_pt_0.12_0.06]"
P1=$($SWEEP $COMMON --symbols "$SYMS_19" --config "$BASE_CFG" --profit-target 0.12 $VOTERS_V02 $BTC_FILTER $CHAMP --max-days 45 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
P2=$($SWEEP $COMMON --symbols "$SYMS_19" --config "$BASE_CFG" --profit-target 0.06 $VOTERS_V02 $BTC_FILTER $CHAMP --max-days 45 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
C=$(awk -v a="$P1" -v b="$P2" 'BEGIN{printf "%.2f", a*b/100}')
echo -e "Z15_pt_0.12_0.06\t$P1\t$P2\t$C" | tee -a "$RESULTS"

echo ""
echo "=== Phase 12 results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -20
