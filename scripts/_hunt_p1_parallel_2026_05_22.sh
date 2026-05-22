#!/bin/bash
# 2026-05-22 Phase-1 knob hunt — ALL variants in parallel (4 threads each, 12 jobs)
set -uo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/hunt_p1
mkdir -p "$OUT"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Base flags — vary one thing per invocation
BASE="$SWEEP \
  --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS --windows 9999 --step-days 1 --threads 4 \
  --signals regime \
  --config 2h-trend-v5-amber-max-passlock \
  --kelly-sizing --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --profit-target 0.10 --max-days 30"

# Baseline fixed flags
DEF_VOTES="--regime-min-votes 2"
DEF_CROSS="--cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50"
DEF_TP="--override-tp-mult 1.10"
DEF_KELLY="--kelly-fraction 0.5"

echo "[$(date +%H:%M:%S)] launching all 12 variants in parallel..."

# (a) tp-mult
$BASE $DEF_VOTES $DEF_CROSS $DEF_KELLY --override-tp-mult 0.90 --out "$OUT/tp090.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_CROSS $DEF_KELLY --override-tp-mult 1.00 --out "$OUT/tp100.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_CROSS $DEF_KELLY --override-tp-mult 1.25 --out "$OUT/tp125.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_CROSS $DEF_KELLY --override-tp-mult 1.40 --out "$OUT/tp140.jsonl" 2>&1 | tail -2 &

# (b) regime-min-votes
$BASE $DEF_CROSS $DEF_TP $DEF_KELLY --regime-min-votes 1 --out "$OUT/votes1.jsonl" 2>&1 | tail -2 &
$BASE $DEF_CROSS $DEF_TP $DEF_KELLY --regime-min-votes 3 --out "$OUT/votes3.jsonl" 2>&1 | tail -2 &

# (c) cross-asset
$BASE $DEF_VOTES $DEF_TP $DEF_KELLY --cross-asset-sym BNBUSDT --cross-asset-fast 9  --cross-asset-slow 21 --out "$OUT/cross_9_21.jsonl"  2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_TP $DEF_KELLY --cross-asset-sym BNBUSDT --cross-asset-fast 12 --cross-asset-slow 26 --out "$OUT/cross_12_26.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_TP $DEF_KELLY --cross-asset-sym BNBUSDT --cross-asset-fast 21 --cross-asset-slow 55 --out "$OUT/cross_21_55.jsonl" 2>&1 | tail -2 &

# (d) kelly
$BASE $DEF_VOTES $DEF_CROSS $DEF_TP --kelly-fraction 0.25 --out "$OUT/kelly025.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_CROSS $DEF_TP --kelly-fraction 0.40 --out "$OUT/kelly040.jsonl" 2>&1 | tail -2 &
$BASE $DEF_VOTES $DEF_CROSS $DEF_TP --kelly-fraction 0.60 --out "$OUT/kelly060.jsonl" 2>&1 | tail -2 &

echo "[$(date +%H:%M:%S)] all launched, waiting..."
wait
echo "[$(date +%H:%M:%S)] all done"

echo ""
echo "=== RESULTS (baseline=52.35%) ==="
python3 - "$OUT" <<'EOF'
import json, os, glob, sys

BASELINE = 52.35
results = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.jsonl"))):
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
for tag, p, n, pct, d in sorted(results, key=lambda x: -x[4]):
    marker = " <<< BEATS BASELINE" if d > 1.0 else ""
    print(f"{tag:<20} {p:>7} {n:>6} {pct:>8.2f}% {d:>+7.2f}pp{marker}")
EOF
