#!/bin/bash
# 2026-05-16 Phase 18 — Multi-Account 3-Stack ECHTE Berechnung.
# Run 3 different configs, dump per-window pass/fail, compute correlation,
# then 3-stack-funded probability (true math, not assumption-based).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS_19="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_16/multi_account
mkdir -p "$OUT"

VOTERS_V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC_FILTER="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS_19 --windows 334 --step-days 3 --threads 14"
CHAMP="--override-tp-mult 1.14 --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20 --max-days 45"

# Config A: AMBER_MAX_PASSLOCK champion
echo "=== Config A: AMBER_MAX_PASSLOCK champion ==="
$SWEEP $COMMON --config "2h-trend-v5-amber-max-passlock" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER $CHAMP --out "$OUT/A_amber_p1.jsonl" 2>&1 | tail -1
$SWEEP $COMMON --config "2h-trend-v5-amber-max-passlock" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER $CHAMP --out "$OUT/A_amber_p2.jsonl" 2>&1 | tail -1

# Config B: V5_TITANIUM_PASSLOCK
echo "=== Config B: V5_TITANIUM_PASSLOCK ==="
$SWEEP $COMMON --config "2h-trend-v5-titanium-passlock" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/B_titanium_p1.jsonl" 2>&1 | tail -1
$SWEEP $COMMON --config "2h-trend-v5-titanium-passlock" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/B_titanium_p2.jsonl" 2>&1 | tail -1

# Config C: V5_OBSIDIAN_PASSLOCK
echo "=== Config C: V5_OBSIDIAN_PASSLOCK ==="
$SWEEP $COMMON --config "2h-trend-v5-obsidian-passlock" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/C_obsidian_p1.jsonl" 2>&1 | tail -1
$SWEEP $COMMON --config "2h-trend-v5-obsidian-passlock" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/C_obsidian_p2.jsonl" 2>&1 | tail -1

# Config D: V5_TOPAZ_PASSLOCK
echo "=== Config D: V5_TOPAZ_PASSLOCK ==="
$SWEEP $COMMON --config "2h-trend-v5-topaz-passlock" --profit-target 0.10 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/D_topaz_p1.jsonl" 2>&1 | tail -1
$SWEEP $COMMON --config "2h-trend-v5-topaz-passlock" --profit-target 0.05 $VOTERS_V02 $BTC_FILTER --override-tp-mult 1.10 --kelly-sizing --max-days 45 --out "$OUT/D_topaz_p2.jsonl" 2>&1 | tail -1

echo ""
echo "Outputs in $OUT/"
ls -la $OUT/
