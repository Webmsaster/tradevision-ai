#!/bin/bash
# 2026-05-22 Phase-1 knob hunt: tp-mult, regime-min-votes, cross-asset pairs, kelly-fraction
# Baseline: 52.35% (535/1022 windows, step=1d, pt=0.10, max-days=30, AMBER_MAX_PASSLOCK+BNB18/50)
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/hunt_p1
mkdir -p "$OUT"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --profit-target 0.10 --max-days 30"

run() {
  local tag="$1"; shift
  local out="$OUT/${tag}.jsonl"
  echo "[$(date +%H:%M:%S)] running $tag …"
  $SWEEP $COMMON "$@" --out "$out" 2>&1 | tail -2
  python3 -c "
import json
data=[json.loads(l) for l in open('$out')]
n=len(data); p=sum(1 for x in data if x.get('passed',False))
print(f'  >>> {p}/{n} = {100*p/n:.2f}%  delta vs 52.35% = {100*p/n-52.35:+.2f}pp')
"
  echo ""
}

echo "=== (a) tp-mult variants ==="
run "tp090" --override-tp-mult 0.90
run "tp100" --override-tp-mult 1.00
# baseline 1.10 already known; skip
run "tp125" --override-tp-mult 1.25
run "tp140" --override-tp-mult 1.40

echo "=== (b) regime-min-votes variants ==="
run "votes1" --regime-min-votes 1
run "votes3" --regime-min-votes 3

echo "=== (c) cross-asset pair variants ==="
run "cross_9_21"  --cross-asset-sym BNBUSDT --cross-asset-fast 9  --cross-asset-slow 21
run "cross_12_26" --cross-asset-sym BNBUSDT --cross-asset-fast 12 --cross-asset-slow 26
run "cross_21_55" --cross-asset-sym BNBUSDT --cross-asset-fast 21 --cross-asset-slow 55

echo "=== (d) kelly-fraction variants ==="
run "kelly025" --kelly-fraction 0.25
run "kelly040" --kelly-fraction 0.40
run "kelly060" --kelly-fraction 0.60

echo ""
echo "=== SUMMARY ==="
python3 - "$OUT" <<'EOF'
import json, os, glob

BASELINE = 52.35
results = []
for f in sorted(glob.glob(os.path.join(os.sys.argv[1], "*.jsonl"))):
    tag = os.path.basename(f).replace(".jsonl","")
    try:
        data = [json.loads(l) for l in open(f)]
        n = len(data)
        p = sum(1 for x in data if x.get("passed", False))
        pct = 100*p/n if n else 0
        delta = pct - BASELINE
        results.append((tag, p, n, pct, delta))
    except Exception as e:
        results.append((tag, 0, 0, 0.0, -BASELINE))

print(f"{'Tag':<20} {'Passed':>7} {'Total':>6} {'Rate%':>8} {'Delta':>8}")
print("-"*55)
for tag, p, n, pct, d in results:
    marker = " <<<" if d > 1.0 else ""
    print(f"{tag:<20} {p:>7} {n:>6} {pct:>8.2f}% {d:>+7.2f}pp{marker}")
EOF
