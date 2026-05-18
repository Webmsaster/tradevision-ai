#!/bin/bash
# 2026-05-18 Multi-Stack + Smart-Timing empirical test.
# Run 7 best phase19 configs with breadth-gate, compute combined Funded-Prob
# where window is funded only if SOME config was qualifying AND passed both
# phases. This is the empirical test of "bot orchestrates 7 accounts with
# smart-timing per account".
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_18/multistack_st
mkdir -p "$OUT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --windows 334 --step-days 3 --threads 8"
V02="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"
BTC="--cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21"
KELLY="--kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20"
GATE="--min-initial-signal-breadth 4 --min-initial-majors 3"

# 7 best configs per memory phase19 (A B C D G H I)
declare -A CONFIGS=(
  [A_amber]="2h-trend-v5-amber-max-passlock --override-tp-mult 1.14 --ptp-levels 0.08:0.25"
  [B_titanium]="2h-trend-v5-titanium-passlock --override-tp-mult 1.10"
  [C_obsidian]="2h-trend-v5-obsidian-passlock --override-tp-mult 1.10"
  [D_topaz]="2h-trend-v5-topaz-passlock --override-tp-mult 1.10"
  [G_diamond]="2h-trend-v5-diamond-passlock --override-tp-mult 1.10"
  [H_amber_ds]="2h-trend-v5-amber-passlock-daystage --override-tp-mult 1.10"
  [I_amber_atr]="2h-trend-v5-amber-atr-passlock --override-tp-mult 1.10"
)

for cfg_label in "${!CONFIGS[@]}"; do
  cfg_args="${CONFIGS[$cfg_label]}"
  p1_out="$OUT/${cfg_label}_p1.jsonl"
  p2_out="$OUT/${cfg_label}_p2.jsonl"
  if [ -f "$p1_out" ] && [ -f "$p2_out" ]; then
    echo "[skip] $cfg_label (cached)"
    continue
  fi
  echo "[run $cfg_label P1]"
  $SWEEP $COMMON $V02 $BTC $KELLY $GATE --config $cfg_args \
    --profit-target 0.10 --max-days 30 --out "$p1_out" 2>&1 | tail -2
  echo "[run $cfg_label P2]"
  $SWEEP $COMMON $V02 $BTC $KELLY $GATE --config $cfg_args \
    --profit-target 0.05 --max-days 60 --out "$p2_out" 2>&1 | tail -2
done

echo
echo "=== Aggregation ==="
python3 scripts/multistack_smart_timing_compute.py "$OUT"
