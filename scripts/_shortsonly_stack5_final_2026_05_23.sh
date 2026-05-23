#!/bin/bash
# 2026-05-23 SHORTS-only Stack-5 final measurement with REVERTED cost-model.
# Goal: measure SHORTS-only P1+P2 under same cost regime as 59.10% Stack-4.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/shortsonly_final_2026_05_23
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 4 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --max-days 30"

CONFIGS=(
  "2h-trend-v5-amber-max-passlock-shorts-only:shortsonly_p1:0.10"
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
echo "=== Pass-rate summary (reverted cost-model) ==="
for f in "$OUT"/*.jsonl; do
  tag=$(basename "$f" .jsonl)
  n=$(wc -l < "$f")
  passed=$(python3 -c "import json; print(sum(1 for l in open('$f') if json.loads(l).get('passed')))")
  pct=$(python3 -c "print(f'{$passed/$n*100:.2f}')")
  echo "$tag: $passed/$n = $pct%"
done

echo ""
echo "=== TRUE-SEQUENTIAL combined-funded (SHORTS-only standalone) ==="
python3 - <<'EOF'
import json
P1 = {json.loads(l)["win_idx"]: (json.loads(l).get("passed"), json.loads(l).get("final_day")) for l in open("scripts/cache_bakeoff/shortsonly_final_2026_05_23/shortsonly_p1.jsonl")}
P2 = {json.loads(l)["win_idx"]: bool(json.loads(l).get("passed")) for l in open("scripts/cache_bakeoff/shortsonly_final_2026_05_23/shortsonly_p2.jsonl")}
total_pairs = 0
both_pass = 0
for w, (p1, fd) in P1.items():
    if not p1 or fd is None:
        continue
    p2w = w + (fd or 30) + 1  # offset+1 honest math
    if p2w in P2:
        total_pairs += 1
        if P2[p2w]:
            both_pass += 1
if total_pairs > 0:
    pct = both_pass / total_pairs * 100
    print(f"SHORTS-only TRUE-SEQUENTIAL: {both_pass}/{total_pairs} = {pct:.2f}%")
else:
    print("No valid P1→P2 pairs found")
EOF
