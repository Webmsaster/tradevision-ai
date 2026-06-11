#!/bin/bash
# 2026-05-16 Phase 4 — Asset-Subset Tests (Korr-aware Sizing).
# 19-Asset baseline vs anti-correlated subsets vs core-only.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase4_subsets.tsv"
: > "$RESULTS"
echo -e "label\tn_assets\tP1\tP2\tcombined_pct" >> "$RESULTS"

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --windows 334 --step-days 3 --threads 14"
BASE_CFG="2h-trend-v5-amber-max-passlock"

run() {
  local label="$1"; local n="$2"; local syms="$3"
  echo "[$label $n assets]"
  local p1=$($SWEEP $COMMON --symbols "$syms" --config "$BASE_CFG" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --symbols "$syms" --config "$BASE_CFG" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$n\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# S00 baseline 19 assets
run "S00_baseline_19" 19 "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

# S01 core blue-chips only (highest liquidity, but high inter-correlation)
run "S01_bluechip_5" 5 "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT"

# S02 anti-correlated 7 (BTC + diverse alts)
run "S02_anticorr_7" 7 "BTCUSDT,XRPUSDT,TRXUSDT,BCHUSDT,LINKUSDT,LTCUSDT,DOTUSDT"

# S03 large-cap 10
run "S03_largecap_10" 10 "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOTUSDT,LINKUSDT,LTCUSDT,BCHUSDT"

# S04 alts only (no BTC/ETH for filter still BTCUSDT)
run "S04_alts_only_12" 12 "AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,DOTUSDT,LINKUSDT,LTCUSDT,NEARUSDT,UNIUSDT,XRPUSDT"

# S05 BTC + ETH only (super tight)
run "S05_btc_eth" 2 "BTCUSDT,ETHUSDT"

# S06 high-vol selection (ALT-heavy)
run "S06_highvol_8" 8 "AAVEUSDT,ARBUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,SOLUSDT,DOTUSDT,UNIUSDT"

# S07 mid-cap focus
run "S07_midcap_9" 9 "ADAUSDT,ATOMUSDT,DOTUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,XRPUSDT,UNIUSDT"

echo ""
echo "=== Phase 4 — Asset Subset results (sorted) ==="
sort -t$'\t' -k5 -rn "$RESULTS" | head -10
