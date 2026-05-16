#!/bin/bash
# 2026-05-16 Phase 23 — Test top hunter candidates on REAL FTMO Standard (P1=0.10/P2=0.05)
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase23_top_hunter.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"

run() {
  local label="$1"; shift
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then echo "[skip-done] $label"; return; fi
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# CHAMP baseline reference
CHAMP_FLAGS="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --max-days 45"
run "Y00_champion" $CHAMP_FLAGS

# Hunter top 1: rubin_passlock + tp 1.05 + mv 4 + voter_set 7214
# 7214 binary = 1110000100111110 → poc_z|bb_z_mr|supertrend|hmm|ad_line|aroon|rsi_hd|smc_fvg|nupl
run "Y01_rubin_top1" \
    --config 2h-trend-v5-rubin-passlock \
    --override-tp-mult 1.05 \
    --signals regime --regime-min-votes 4 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm \
    --regime-use-aroon --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --max-days 45

# Variant: rubin + tp 1.05 + mv 3 + voter_set 7278
run "Y02_rubin_top2_mv3" \
    --config 2h-trend-v5-rubin-passlock \
    --override-tp-mult 1.05 \
    --signals regime --regime-min-votes 3 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm \
    --regime-use-aroon --regime-use-cmf --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --max-days 45

# Add Kelly to hunter winner
run "Y03_rubin_top1_+kelly" \
    --config 2h-trend-v5-rubin-passlock \
    --override-tp-mult 1.05 \
    --signals regime --regime-min-votes 4 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm \
    --regime-use-aroon --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 \
    --max-days 45

# Add BTC cross-asset filter
run "Y04_rubin_top1_+btc" \
    --config 2h-trend-v5-rubin-passlock \
    --override-tp-mult 1.05 \
    --signals regime --regime-min-votes 4 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm \
    --regime-use-aroon --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 \
    --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 \
    --max-days 45

# Sapphir + tp 1.35 + mv 2
run "Y05_sapphir_top" \
    --config 2h-trend-v5-sapphir-passlock \
    --override-tp-mult 1.35 \
    --signals regime --regime-min-votes 2 \
    --regime-poc-z --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
    --regime-use-aroon --regime-use-double-top --regime-use-rsi-hidden-div --regime-use-nupl \
    --max-days 45

# Diamond + tp 1.45 + mv 2
run "Y06_diamond_top" \
    --config 2h-trend-v5-diamond-passlock \
    --override-tp-mult 1.45 \
    --signals regime --regime-min-votes 2 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
    --regime-use-aroon --regime-use-cmf --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --max-days 45

# Diamond + Champion-flavors
run "Y07_diamond_+kelly_btc" \
    --config 2h-trend-v5-diamond-passlock \
    --override-tp-mult 1.45 \
    --signals regime --regime-min-votes 2 \
    --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
    --regime-use-aroon --regime-use-cmf --regime-use-rsi-hidden-div --regime-use-smc-fvg --regime-use-nupl \
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21 \
    --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 \
    --max-days 45

echo ""
echo "=== Phase 23 results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -10
