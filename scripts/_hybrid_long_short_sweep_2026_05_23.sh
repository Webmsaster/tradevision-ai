#!/bin/bash
# 2026-05-23 HYBRID Long+Short single-account fusion sweep.
# Goal: Measure if combined AMBER-long + SHORTS-only on ONE account
# approaches the 70% OR-upper-bound or collapses to ~30% via hedge-cost.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/hybrid_long_short_2026_05_23
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
  "2h-trend-v5-amber-max-passlock-hybrid:hybrid_p1:0.10"
  "2h-trend-v5-amber-max-passlock-hybrid:hybrid_p2:0.05"
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
echo "=== HYBRID single-account pass-rates ==="
for f in "$OUT"/*.jsonl; do
  tag=$(basename "$f" .jsonl)
  n=$(wc -l < "$f")
  passed=$(python3 -c "import json; print(sum(1 for l in open('$f') if json.loads(l).get('passed')))")
  pct=$(python3 -c "print(f'{$passed/$n*100:.2f}')")
  echo "$tag: $passed/$n = $pct%"
done

echo ""
echo "=== TRUE-SEQUENTIAL combined-funded (HYBRID single-account) ==="
python3 - <<'EOF'
import json
P1 = {}
for l in open("scripts/cache_bakeoff/hybrid_long_short_2026_05_23/hybrid_p1.jsonl"):
    o = json.loads(l)
    P1[o["win_idx"]] = (bool(o.get("passed")), o.get("final_day"))
P2 = {}
for l in open("scripts/cache_bakeoff/hybrid_long_short_2026_05_23/hybrid_p2.jsonl"):
    o = json.loads(l)
    P2[o["win_idx"]] = bool(o.get("passed"))

total_pairs = 0
both_pass = 0
for w, (p1, fd) in P1.items():
    if not p1 or fd is None:
        continue
    p2w = w + fd + 1
    if p2w in P2:
        total_pairs += 1
        if P2[p2w]:
            both_pass += 1

print(f"HYBRID TRUE-SEQUENTIAL: {both_pass}/{total_pairs} = {both_pass/max(total_pairs,1)*100:.2f}% (conditional P2|P1)")
total = len(P1)
abs_combined = both_pass / total * 100 if total else 0
print(f"HYBRID absolute combined-funded: {both_pass}/{total} = {abs_combined:.2f}%")
print(f"")
print(f"Reference (same 1023 windows, reverted costs):")
print(f"  AMBER alone:  conditional 61.32%, absolute ~32.1%")
print(f"  SHORTS alone: conditional 58.09%, absolute ~29.1%")
print(f"  OR-upper-bound: ~70.7% absolute (window-level OR-math)")
print(f"  Stack-4 OR:   59.10% (multi-account 4× separate accounts)")
EOF
