#!/bin/bash
# 2026-05-23 SHORTS-only V5_AMBER_MAX_PASSLOCK + cost-rebaseline sweep.
# Two cells in parallel:
#   1) Stack-4 baseline RE-MEASURED with new per-asset costs (sanity-check)
#   2) SHORTS-only standalone P1 + P2 pass-rate + corr-vs-AMBER
# Goal: verify SHORTS-only Stack-5 uplift projection (+4.5 to +5.5pp).

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/shortsonly_2026_05_23
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Common base — matches wave3_4thmember + cost-rebaseline.
BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 4 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --max-days 30"

CONFIGS=(
  "2h-trend-v5-amber-max-passlock-shorts-only:shortsonly:0.10"
  "2h-trend-v5-amber-max-passlock:amber_rebaseline:0.10"
  "2h-trend-v5-amber-max-passlock-shorts-only:shortsonly_p2:0.05"
)

PIDS=()
for entry in "${CONFIGS[@]}"; do
  cfg=$(echo "$entry" | cut -d: -f1)
  tag=$(echo "$entry" | cut -d: -f2)
  pt=$(echo "$entry" | cut -d: -f3)
  out="$OUT/${tag}.jsonl"
  if [[ -f "$out" ]]; then echo "[skip] $tag"; continue; fi
  echo "[launch] $tag (cfg=$cfg pt=$pt)"
  ( $SWEEP $BASE --config "$cfg" --profit-target "$pt" --out "$out" 2>&1 | tail -3 ; echo "[done] $tag" ) > "$OUT/${tag}.log" 2>&1 &
  PIDS+=($!)
done
echo "Launched ${#PIDS[@]} parallel sweeps. Waiting..."
for pid in "${PIDS[@]}"; do wait $pid; done

echo ""
echo "=== Pass-rate summary ==="
for f in "$OUT"/*.jsonl; do
  tag=$(basename "$f" .jsonl)
  n=$(wc -l < "$f")
  passed=$(python3 -c "import json; print(sum(1 for l in open('$f') if json.loads(l).get('passed')))")
  pct=$(python3 -c "print(f'{$passed/$n*100:.2f}')")
  echo "$tag: $passed/$n = $pct%"
done
