#!/bin/bash
# 2026-05-16 Phase 1 Hunt — all new Phase 1+2 levers from 50-agent brainstorm.
# Test against V01 baseline (33.69 Combined Funded post-fix).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16
mkdir -p "$OUT"
RESULTS="$OUT/phase1.tsv"
if [ "${FORCE_RESET:-0}" = "1" ] || [ ! -s "$RESULTS" ]; then
  : > "$RESULTS"
  echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"
fi

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"

START_TS=$(date +%s)
COUNT=0
TOTAL=14

# Separate P1 and P2 args (because phase-aware risk-mult only applies to P2)
runp() {
  local label="$1"; local cfg="$2"; local p1_extra="$3"; local p2_extra="$4"
  COUNT=$((COUNT + 1))
  if grep -q "^${label}"$'\t' "$RESULTS" 2>/dev/null; then
    echo "[skip-done $COUNT/$TOTAL] $label"; return
  fi
  local elapsed=$(($(date +%s) - START_TS))
  echo "[$COUNT/$TOTAL @ ${elapsed}s] $label"
  local p1=$($SWEEP $COMMON --config "$cfg" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER $p1_extra 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --config "$cfg" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $p2_extra 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local combined=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$combined" | tee -a "$RESULTS"
}

# ===== P00: baseline reference =====
runp "P00_baseline"                "2h-trend-v5-amber-max-passlock"            ""                                  ""

# ===== P01-P03: MPTP V04a (tiers under tp_pct) =====
runp "P01_mptp_v04a"               "2h-trend-v5-amber-max-passlock-mptp-v04a"  ""                                  ""

# ===== P02: Sharpe-tier-tightening =====
runp "P02_sharpe_tight"            "2h-trend-v5-amber-max-passlock-sharpe-tight" ""                                ""

# ===== P03-P05: Kelly-Sizing CLI activation =====
runp "P03_kelly_default"           "2h-trend-v5-amber-max-passlock"            "--kelly-sizing"                    "--kelly-sizing"
runp "P04_kelly_win60_min15"       "2h-trend-v5-amber-max-passlock"            "--kelly-sizing --kelly-window 60 --kelly-min-trades 15" "--kelly-sizing --kelly-window 60 --kelly-min-trades 15"
runp "P05_kelly_win100_min30"      "2h-trend-v5-amber-max-passlock"            "--kelly-sizing --kelly-window 100 --kelly-min-trades 30" "--kelly-sizing --kelly-window 100 --kelly-min-trades 30"

# ===== P06-P09: Phase-aware risk multiplier (P2 only) =====
runp "P06_p2lev_0.5"               "2h-trend-v5-amber-max-passlock"            ""                                  "--phase2-risk-mult 0.5"
runp "P07_p2lev_0.6"               "2h-trend-v5-amber-max-passlock"            ""                                  "--phase2-risk-mult 0.6"
runp "P08_p2lev_0.7"               "2h-trend-v5-amber-max-passlock"            ""                                  "--phase2-risk-mult 0.7"
runp "P09_p2lev_0.8"               "2h-trend-v5-amber-max-passlock"            ""                                  "--phase2-risk-mult 0.8"

# ===== P10-P13: Stacked combinations =====
runp "P10_mptp+kelly"              "2h-trend-v5-amber-max-passlock-mptp-v04a"  "--kelly-sizing"                    "--kelly-sizing"
runp "P11_mptp+sharpe-tight"       "2h-trend-v5-amber-max-passlock-mptp-v04a"  ""                                  ""
runp "P12_kelly+p2lev_0.7"         "2h-trend-v5-amber-max-passlock"            "--kelly-sizing"                    "--kelly-sizing --phase2-risk-mult 0.7"
runp "P13_mega"                    "2h-trend-v5-amber-max-passlock-mptp-v04a"  "--kelly-sizing"                    "--kelly-sizing --phase2-risk-mult 0.7"

echo ""
echo "=== TOP 10 Phase 1 results ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -11
