#!/bin/bash
# 2026-05-22 A/B sweep: exit.rs PTP cost double-charge fix (commit cfd6046).
# Same champion config (AMBER_MAX_PASSLOCK, Basket-18 + BNB 18/50, tp=1.10,
# Kelly 0.5, 5 voters), run with pre-fix binary vs freshly-built post-fix binary.
# Goal: confirm the fix moves PASSLOCK pass-rate slightly UP (cost was double-charged).
set -euo pipefail
cd "$(dirname "$0")/.."

PREFIX=/tmp/ftmo-sweep.prefix
POSTFIX=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/ptp_fix_ab
RESULTS="$OUT/results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
echo -e "label\tbinary\tpct\tpass\ttotal" >> "$RESULTS"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --profit-target 0.10 --max-days 30 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --strict-pass"

V5="--regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"

run() {
  local label="$1"; local bin="$2"; shift 2
  local outfile="$OUT/${label}.jsonl"
  echo ""
  echo "[run] $label ($bin)"
  local raw=$($bin $COMMON "$@" --out "$outfile" 2>&1 | tail -5)
  echo "$raw" | tail -3
  local pct=$(echo "$raw" | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  local pass_total=$(echo "$raw" | grep -oE '[0-9]+/[0-9]+' | tail -1)
  local pass=$(echo "$pass_total" | cut -d/ -f1)
  local total=$(echo "$pass_total" | cut -d/ -f2)
  echo -e "$label\t$bin\t${pct:-NA}\t${pass:-NA}\t${total:-NA}" | tee -a "$RESULTS"
}

START_TS=$(date +%s)

run "PREFIX_baseline_5v"   "$PREFIX"  $V5
run "POSTFIX_baseline_5v"  "$POSTFIX" $V5

# With multi-level PTP active — this is where the exit.rs cost-double-charge
# fix actually changes behaviour (champion 2026-05-17/18 used ptp 0.08:0.25).
run "PREFIX_ptp_0.08:0.25"  "$PREFIX"  $V5 --ptp-levels "0.08:0.25"
run "POSTFIX_ptp_0.08:0.25" "$POSTFIX" $V5 --ptp-levels "0.08:0.25"

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== PTP-fix A/B complete in ${ELAPSED}s ==="
echo ""
column -t -s$'\t' "$RESULTS"
