#!/bin/bash
# 2026-05-23 TITANIUM_PASSLOCK avg_trades-boost sweep.
# Hypothesis: bucket-analysis shows windows with <5 trades = 0% pass-rate.
# Current avg_trades=7.9. Boost to 12-15 → projected +5-15pp uplift.
# Levers (sweep.rs lines): --override-mct (L1414), --override-hours (L1428),
# --override-hold-bars (L1425). NO regime-cooldown, NO atr-gate (TITANIUM is
# plain V3 trend, see templates.rs:424-455). Baseline 49.54% step=1d.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/step1_titanium_trades_boost
mkdir -p "$OUT"
RESULTS="$OUT/results.tsv"
: > "$RESULTS"
echo -e "cell\tlabel\tpct\tpass\ttotal\tavg_trades" >> "$RESULTS"

# V5_TITANIUM 14-asset basket (templates.rs V5_TITANIUM_BASKET)
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETHUSDT,LINKUSDT,LTCUSDT,SOLUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --profit-target 0.10 --max-days 30 \
  --config 2h-trend-v5-titanium-passlock \
  --strict-pass"

run() {
  local cell="$1"; local label="$2"; shift 2
  local outfile="$OUT/${cell}_${label}.jsonl"
  echo "[run] $cell $label  args: $*"
  local raw
  raw=$($SWEEP $COMMON "$@" --out "$outfile" 2>&1 | tail -5)
  local pct pass_total pass total avg
  pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  pass_total=$(echo "$raw" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  pass=$(echo "$pass_total" | cut -d/ -f1)
  total=$(echo "$pass_total" | cut -d/ -f2)
  # avg_trades parsed from jsonl: sum(closed_trades)/n
  avg=$(jq -s 'map(.closed_trades // 0)|add/length' "$outfile" 2>/dev/null || echo NA)
  echo -e "$cell\t$label\t${pct:-NA}\t${pass:-NA}\t${total:-NA}\t${avg}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

# Cell A — baseline (current TITANIUM_PASSLOCK), expected ~49.5%, avg ~7.9
run "A" "baseline"
# Cell B — mct 6 → 10 (Lever 3, +parallelism)
run "B" "mct10"     --override-mct 10
# Cell C — hours +0,16 → 12 slots (Lever 4, +20% trading window)
run "C" "hours12"   --override-hours 0,2,4,6,8,10,12,14,16,18,20,22
# Cell D — hold_bars 240 → 120 (Lever 1 surrogate, ×2 turnover)
run "D" "hold120"   --override-hold-bars 120
# Cell E — ALL THREE combined
run "E" "combo"     --override-mct 10 --override-hours 0,2,4,6,8,10,12,14,16,18,20,22 --override-hold-bars 120

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== TITANIUM trades-boost sweep complete in ${ELAPSED}s ==="
echo ""
sort -t$'\t' -k3 -rn "$RESULTS" | column -t -s$'\t'
