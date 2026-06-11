#!/bin/bash
# 2026-05-16 Phase 15 (Per-asset tp_mult CSV) + Phase 16 (Disagreement-Bonus).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase15_16.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"
CHAMP="--override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --max-days 45"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Champion baseline
run "G00_champion"

# Phase 16 — Disagreement-Bonus alone
run "G01_disagreement_bonus"  --regime-disagreement-bonus

# Phase 15 — Per-asset tp_mult tests
# Strategy A: bluechip lower (BTC/ETH), alts higher
run "G02_bluechip_lo_alts_hi"  \
    --override-tp-mult-per-asset "BTCUSDT=0.95,ETHUSDT=0.95,BNBUSDT=0.95,SOLUSDT=1.10,AVAXUSDT=1.10,NEARUSDT=1.15,ARBUSDT=1.15"

# Strategy B: tight for high-cap, loose for mid-cap
run "G03_tightblock_4assets"  \
    --override-tp-mult-per-asset "BTCUSDT=1.00,ETHUSDT=1.00,BNBUSDT=1.00,XRPUSDT=1.00"

# Strategy C: all alts +10%
run "G04_alts_plus10"  \
    --override-tp-mult-per-asset "AAVEUSDT=1.10,ALGOUSDT=1.10,ARBUSDT=1.10,ATOMUSDT=1.10,AVAXUSDT=1.10,NEARUSDT=1.10,UNIUSDT=1.10,LINKUSDT=1.10"

# Strategy D: bluechip -10% (since tp_mult 1.14 already, this = 1.026 effective)
run "G05_bluechip_minus10"  \
    --override-tp-mult-per-asset "BTCUSDT=0.90,ETHUSDT=0.90,BNBUSDT=0.90"

# Strategy E: high-vol assets +20%, low-vol -10%
run "G06_volcap"  \
    --override-tp-mult-per-asset "BTCUSDT=0.90,ETHUSDT=0.90,LTCUSDT=0.95,BCHUSDT=0.95,ETCUSDT=0.95,TRXUSDT=0.95,SOLUSDT=1.15,AVAXUSDT=1.15,NEARUSDT=1.15,ARBUSDT=1.20,UNIUSDT=1.15,AAVEUSDT=1.15"

# Combo: per-asset + disagreement-bonus
run "G07_volcap_disag"  --regime-disagreement-bonus \
    --override-tp-mult-per-asset "BTCUSDT=0.90,ETHUSDT=0.90,LTCUSDT=0.95,SOLUSDT=1.15,AVAXUSDT=1.15,NEARUSDT=1.15,ARBUSDT=1.20"

# Heavy-skew test
run "G08_extreme_alts"  \
    --override-tp-mult-per-asset "BTCUSDT=0.80,ETHUSDT=0.80,SOLUSDT=1.30,AVAXUSDT=1.30,NEARUSDT=1.30,ARBUSDT=1.30"

echo ""
echo "=== Phase 15+16 results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -15
