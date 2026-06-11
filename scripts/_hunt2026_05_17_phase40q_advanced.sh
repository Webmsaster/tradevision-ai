#!/bin/bash
# 2026-05-17 Phase 40-Q — Advanced engine features on top of PTP P06 winner.
# Hypothesis: combining PTP @ 8% with break-even stops, time-decay sizing,
# trailing stops, or sharpe-sizing might compound +0.5-1pp more.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase40q_advanced.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"
CHAMP="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  [ -z "$p1" ] || [ -z "$p2" ] && { echo "[skip-empty] $label"; return; }
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Baseline P06 (sanity)
run "Z00_p06_baseline"

# Break-even stop variations (move stop to entry after X% profit)
run "A01_be_0.02" --be-threshold 0.02
run "A02_be_0.03" --be-threshold 0.03
run "A03_be_0.05" --be-threshold 0.05
run "A04_be_0.07" --be-threshold 0.07

# Time-decay sizing (reduce size after day X to protect deadline)
run "B01_td_default" --td-enable
run "B02_td_start12_decay0.5" --td-enable --td-start-day 12 --td-decay 0.5
run "B03_td_start20_min0.2" --td-enable --td-start-day 20 --td-min-factor 0.2
run "B04_td_mult_mode" --td-enable --td-mode mult

# Sharpe sizing (alternative to Kelly)
run "C01_sharpe" --sharpe-sizing

# Loss-streak cooldown (pause after losses)
run "D01_lscool_4after5" --lscool-after 5 --lscool-bars 4
run "D02_lscool_3after3" --lscool-after 3 --lscool-bars 3

# Min-votes 3 (stricter consensus, fewer/better signals)
run "E01_minvotes3" --regime-min-votes 3
run "E02_minvotes3_no_ad" --regime-min-votes 3
# Note: E02 same flags as E01 — Phase 25 showed dropping ad_line hurts

# Disagreement bonus + PTP
run "F01_disagreement_bonus" --regime-disagreement-bonus

echo ""
echo "=== Phase 40-Q results (sorted) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -10
