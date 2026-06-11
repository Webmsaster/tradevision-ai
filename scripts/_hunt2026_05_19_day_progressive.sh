#!/bin/bash
# 2026-05-19 Research: Day-Progressive-Sizing Sweep.
#
# Hypothesis: Round 2 found 78% of fails are Day 1-2 events. Smaller sizing
# on day 1-3 might avoid early DL/TL breaches and let the equity ramp later.
#
# CLI flags found (engine-rust/ftmo-engine-cli/src/sweep.rs):
#   --ds-aggressive-until <day>   default 3
#   --ds-aggressive-factor <f>    default 1.5
#   --ds-neutral-until <day>      default 8
#   --ds-neutral-factor <f>       default 1.0
#   --ds-defensive-factor <f>     default 0.7
#   --ds-progress-frac <f>        equity-progress trigger
#   --ds-progress-factor <f>      override factor when triggered
#   --disable-day-stage           kill-switch
#
# Tier ladder: [day>=0: aggressive, day>=agg_until: neutral, day>=neu_until: defensive]
# Logic: highest matching tier wins (sorted desc by day_at_least).
#
# To DEFEND day 1-3, set aggressive_factor < 1.0 (e.g. 0.5, 0.7), neutral_factor=1.0,
# defensive_factor may stay 0.7 or be raised. Champion baseline uses NO day-stage.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/day_progress_hunt
RESULTS="$OUT/day_progress_results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tP1\tP2\tcombined_pct" >> "$RESULTS"

V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 4"
CHAMP_P1="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.40 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"
CHAMP_P2="--config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --ptp-levels 0.08:0.25"

run() {
  local label="$1"; shift
  echo "[$label]"
  local p1=$($SWEEP $COMMON --profit-target 0.10 --max-days 30 $V02 $BTC $CHAMP_P1 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local p2=$($SWEEP $COMMON --profit-target 0.05 --max-days 60 $V02 $BTC $CHAMP_P2 "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p1" ] || [ -z "$p2" ]; then echo "[skip-empty] $label"; return; fi
  local c=$(awk -v a="$p1" -v b="$p2" 'BEGIN{printf "%.2f", a*b/100}')
  echo -e "$label\t$p1\t$p2\t$c" | tee -a "$RESULTS"
}

# A) Baseline — NO day-stage (current champion).
run "A_baseline_no_dayStage"

# B) Mild defense day 1-2 (factor 0.7), then neutral, then mild defensive day 8+.
run "B_d1_2_f0.7" --ds-aggressive-until 2 --ds-aggressive-factor 0.7 --ds-neutral-until 8 --ds-neutral-factor 1.0 --ds-defensive-factor 0.85

# C) Stronger defense day 1-3 (factor 0.5).
run "C_d1_3_f0.5" --ds-aggressive-until 3 --ds-aggressive-factor 0.5 --ds-neutral-until 8 --ds-neutral-factor 1.0 --ds-defensive-factor 0.85

# D) Very conservative day 1-3 (factor 0.3) — survive period.
run "D_d1_3_f0.3" --ds-aggressive-until 3 --ds-aggressive-factor 0.3 --ds-neutral-until 8 --ds-neutral-factor 1.0 --ds-defensive-factor 0.85

# E) Mild day 1-3 (0.7) + RAMP UP day 4-7 (1.2) — early survive + push later.
run "E_d1_3_f0.7_ramp1.2" --ds-aggressive-until 3 --ds-aggressive-factor 0.7 --ds-neutral-until 8 --ds-neutral-factor 1.2 --ds-defensive-factor 0.85

# F) Defense day 1-5 (0.6), then full size — long ramp.
run "F_d1_5_f0.6" --ds-aggressive-until 5 --ds-aggressive-factor 0.6 --ds-neutral-until 12 --ds-neutral-factor 1.0 --ds-defensive-factor 0.85

# G) Day 1 only ultra-conservative (0.3), day 2-3 mild (0.7).
# Engine only supports 3 tiers, so use day 1 + neutral_until=4 + defensive late.
# Approximate via: aggressive_until=1, factor 0.3 → only day 0 gets 0.3.
# But: tier logic picks "highest day_at_least <= state.day". Day 0 has agg only.
# We'll approximate with 2 tiers: very-conservative day 0-1, neutral after.
run "G_d1only_f0.3" --ds-aggressive-until 1 --ds-aggressive-factor 0.3 --ds-neutral-until 4 --ds-neutral-factor 0.7 --ds-defensive-factor 1.0

# H) Equity-progress override only (no day-stage): once 50% of target hit,
#    cap sizing at 0.5 — test "preserve gains after partial breach".
run "H_progress_50_f0.5" --ds-progress-frac 0.5 --ds-progress-factor 0.5

echo ""
echo "=== Day-Progressive sweep results (sorted by Combined desc) ==="
sort -t$'\t' -k4 -rn "$RESULTS" | head -10
