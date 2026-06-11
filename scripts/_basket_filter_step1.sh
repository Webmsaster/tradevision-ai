#!/bin/bash
# 2026-05-20 Per-Asset Basket Filter Sweep (step=1d)
# Goal: drop toxic assets from Basket-18, test if 13/15-basket lifts pass-rate.
# Audit-data: scripts/cache_bakeoff/per_asset_audit.tsv
#
# Ranking (EV/trade, worst first):
#   ATOM -0.924, UNI -0.736, LINK -0.641, XRP -0.456, AAVE -0.371,
#   ARB -0.349, AVAX -0.085, NEAR -0.030, BCH -0.023, ADA -0.009
#   then positive: ALGO, SOL, ETH, BNB, LTC, ETC, DOT, BTC, TRX
#
# Ranking (Total contribution, worst first):
#   AAVE -49.71, XRP -45.65, ARB -33.87, ATOM -28.65, LINK -22.45
#
# Baseline Basket-18 = 52.31% step=1d (533/1019)

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/basket_filter
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
echo -e "label\tn_assets\tpct\tpassed\ttotal" >> "$RESULTS"

# Basket-18 (matches existing 52.31% baseline)
B18="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Drop worst 3 by EV/trade: ATOM, UNI, LINK → 15 assets
B15_EV3="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LTCUSDT,NEARUSDT,SOLUSDT,XRPUSDT"

# Drop worst 5 by EV/trade: ATOM, UNI, LINK, XRP, AAVE → 13 assets
B13_EV5="ADAUSDT,ALGOUSDT,ARBUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LTCUSDT,NEARUSDT,SOLUSDT"

# Drop worst 3 by TOTAL contribution: AAVE, XRP, ARB → 15 assets
B15_TOT3="ADAUSDT,ALGOUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT"

# Top-8 edge: DOT, ETC, ALGO, NEAR, ETH, BTC, BNB, SOL (top 8 win-rate, n>=30)
B08_TOP="ALGOUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,NEARUSDT,SOLUSDT"

# Expanded: B18 + DOGE + SAND + STX (the 3 lowest-hurt extras at step=7) → 21 assets
B21_EXP="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOGEUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SANDUSDT,SOLUSDT,STXUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --windows 9999 --step-days 1 --threads 2 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend \
  --regime-use-hmm --regime-use-ad-line \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

run_basket() {
  local label="$1"; local syms="$2"
  local outfile="$OUT/${label}.jsonl"
  local n=$(echo "$syms" | tr ',' '\n' | wc -l)
  local t0=$(date +%s)
  echo "[$(date +%H:%M:%S)] [run] $label (n=$n)"
  $SWEEP $COMMON --symbols "$syms" --out "$outfile" >"$OUT/${label}.log" 2>&1 || {
    echo "  FAIL — see $OUT/${label}.log"
    return 1
  }
  # Aggregate from jsonl
  local rates=$(python3 -c "
import json
total=0; passed=0
for line in open('$outfile'):
    try:
        d=json.loads(line)
        total+=1
        if d.get('passed'): passed+=1
    except: pass
print(f'{passed}\t{total}\t{passed/total*100:.2f}' if total else 'NA\tNA\tNA')")
  local pass=$(echo "$rates" | cut -f1)
  local total=$(echo "$rates" | cut -f2)
  local pct=$(echo "$rates" | cut -f3)
  local dt=$(($(date +%s) - t0))
  echo "  -> ${pct}% ($pass/$total) in ${dt}s"
  echo -e "${label}\t${n}\t${pct}\t${pass}\t${total}" >> "$RESULTS"
}

START_TS=$(date +%s)

# Baseline confirmation FIRST so we have an apples-to-apples reference run
run_basket "B18_baseline"        "$B18"
run_basket "B15_drop3_EV"        "$B15_EV3"
run_basket "B13_drop5_EV"        "$B13_EV5"
run_basket "B15_drop3_TOTAL"     "$B15_TOT3"
run_basket "B08_top8_edge"       "$B08_TOP"
run_basket "B21_expand_DOGE_SAND_STX" "$B21_EXP"

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== Basket-Filter Sweep done in ${ELAPSED}s ==="
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
