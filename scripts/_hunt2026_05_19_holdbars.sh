#!/bin/bash
# 2026-05-19 Research: hold_bars (position duration limit) sweep at step=1.
#
# Engine default cfg.hold_bars = 240 (= 5 days @ 30m bars, 48 bars/day).
# CLI: --override-hold-bars <N> (engine-rust/ftmo-engine-cli/src/sweep.rs:1377)
# Override applies to cfg.hold_bars AND every per-asset asset.hold_bars.
#
# Sweep values (raw bar counts at 30m):
#   12 bars = 6h, 24 = 12h, 36 = 18h, 48 = 24h, 72 = 36h, 96 = 48h, 240 = 5d (default)
#
# Champion: Basket-18 + BNB 18/50 + tp_mult=1.10 + AMBER_MAX_PASSLOCK +
#           regime 2-vote + half-Kelly w60/min20 + strict-pass.
# Baseline (default hold_bars=240) ≈ 52.31% at step=1.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_holdbars
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
echo -e "label\thold_bars\tpct\tpass\ttotal" >> "$RESULTS"

SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

CHAMPION="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS \
  --windows 9999 --step-days 1 --threads 8 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend \
  --regime-use-hmm --regime-use-ad-line \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

run() {
  local hb="$1"
  local label="hb${hb}"
  local outfile="$OUT/${label}.jsonl"
  echo "[run] $label (hold_bars=$hb)"
  local raw=$($SWEEP $CHAMPION --override-hold-bars "$hb" --out "$outfile" 2>&1 | tail -3)
  echo "  $raw" | tr '\n' ' '; echo ""
  local pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  local pass_total=$(echo "$raw" | grep -oE 'passed=[0-9]+ / [0-9]+' | head -1 | grep -oE '[0-9]+ / [0-9]+' | tr -d ' ')
  local pass=$(echo "$pass_total" | cut -d/ -f1)
  local total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t$hb\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

for HB in 12 24 36 48 72 96; do
  run "$HB"
done

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== hold_bars sweep complete in ${ELAPSED}s ==="
echo ""
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
