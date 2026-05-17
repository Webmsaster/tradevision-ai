#!/bin/bash
# 2026-05-17 Phase 34-Q — Try DIFFERENT base configs with V02 voters.
# AMBER_MAX is local optimum: every voter we add hurts. Maybe a different
# base config has more room for voters. Quick 100-window screen.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_17
RESULTS="$OUT/phase34q_base_configs.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tconfig\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 100 --step-days 3 --threads 8"

run() {
  local label="$1"; local cfg="$2"
  echo "[$label cfg=$cfg]"
  local CHAMP="--config $cfg --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$cfg\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# Sister-PASSLOCK configs documented in CLAUDE.md
run "C01_AMBER_MAX"    "2h-trend-v5-amber-max-passlock"
run "C02_AMBER"        "2h-trend-v5-amber-passlock"
run "C03_AMBER_ATR"    "2h-trend-v5-amber-atr-passlock"
run "C04_AMBER_DAYSTAGE" "2h-trend-v5-amber-passlock-daystage"
run "C05_TITANIUM"     "2h-trend-v5-titanium-passlock"
run "C06_RUBIN"        "2h-trend-v5-rubin-passlock"
run "C07_SAPPHIR"      "2h-trend-v5-sapphir-passlock"
run "C08_DIAMOND"      "2h-trend-v5-diamond-passlock"
run "C09_OBSIDIAN"     "2h-trend-v5-obsidian-passlock"
run "C10_TOPAZ"        "2h-trend-v5-topaz-passlock"
run "C11_R28_V6"       "2h-trend-v5-quartz-lite-r28-v6-passlock"

echo ""
echo "=== Phase 34-Q base configs (sorted by Combined desc) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -12
