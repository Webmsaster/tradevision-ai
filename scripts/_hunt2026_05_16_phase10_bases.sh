#!/bin/bash
# 2026-05-16 Phase 10 — Try OTHER base configs (V5_TITANIUM, V5_OBSIDIAN) +
# super-stack micro-tweaks at champion tp_mult 1.14.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase10_bases.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
KELLY="--kelly-sizing --kelly-window 100 --kelly-min-trades 30"
ADLINE="--regime-use-ad-line"

run() {
  local label="$1"; local cfg="$2"; shift 2
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --config "$cfg" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$cfg" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

CHAMP="--override-tp-mult 1.14 $KELLY $ADLINE"

# B00 champion replicate (X03)
run "B00_champion_X03"        "2h-trend-v5-amber-max-passlock" $CHAMP

# Other AMBER variants
run "B01_amber_passlock"      "2h-trend-v5-amber-passlock"     $CHAMP
run "B02_amber_daystage"      "2h-trend-v5-amber-daystage"     $CHAMP

# V5 sister configs (PASSLOCK family)
run "B03_titanium_passlock"   "2h-trend-v5-titanium-passlock"  $CHAMP
run "B04_obsidian_passlock"   "2h-trend-v5-obsidian-passlock"  $CHAMP
run "B05_topaz_passlock"      "2h-trend-v5-topaz-passlock"     $CHAMP
run "B06_rubin_passlock"      "2h-trend-v5-rubin-passlock"     $CHAMP

# Other ALPHA / Quartz family
run "B07_r28_v6_passlock"     "2h-trend-v5-quartz-lite-r28-v6-passlock" $CHAMP

# Micro-tweaks at tp 1.14
run "B08_1.14+min_v2_strict"  "2h-trend-v5-amber-max-passlock" $CHAMP
run "B09_1.14+lev_1.05"       "2h-trend-v5-amber-max-passlock" $CHAMP --override-leverage 1.05
run "B10_1.14+lev_1.10"       "2h-trend-v5-amber-max-passlock" $CHAMP --override-leverage 1.10
run "B11_1.14+lev_0.95"       "2h-trend-v5-amber-max-passlock" $CHAMP --override-leverage 0.95
run "B12_1.14+be_0.01"        "2h-trend-v5-amber-max-passlock" $CHAMP --be-threshold 0.01
run "B13_1.14+be_0.02"        "2h-trend-v5-amber-max-passlock" $CHAMP --be-threshold 0.02
run "B14_1.14+adaptive_atr"   "2h-trend-v5-amber-max-passlock" $CHAMP --adaptive-tp atr

# Sharpe-sizing variants on champion
run "B15_1.14+sharpe"         "2h-trend-v5-amber-max-passlock" $CHAMP --sharpe-sizing
run "B16_1.14+td_decay"       "2h-trend-v5-amber-max-passlock" $CHAMP --td-enable

echo ""
echo "=== Phase 10 results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -20
