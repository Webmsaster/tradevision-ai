#!/usr/bin/env bash
# Design-overfit OOS data generation: configs × baskets × TUNED KNOBS.
# The knobs (tp_mult, min_votes, kelly) are the parameters tuned on full history
# project-wide — this is the design-overfit axis the selection-OOS did NOT test.
# Select the best stack on train, measure on test (scripts/oos_design_analyze.py).
# FTMO, close-based, step=3, full windows. Throttled jobs=4 (WSL2 crash-safe).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWEEP="$ROOT/engine-rust/target/release/ftmo-sweep"; C="scripts/cache_bakeoff"
O="${1:-/tmp/oos_design}"; mkdir -p "$O"
JOBS=4

declare -A CFG=(
 [diamond]="2h-trend-v5-diamond-passlock"
 [sharpe]="2h-trend-v5-amber-max-passlock-sharpe-tight"
 [obsidian]="2h-trend-v5-obsidian-passlock"
 [rubin]="2h-trend-v5-rubin-passlock")
declare -A BASK=(
 [l1beta]="AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT"
 [alt5]="AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT"
 [defi4]="AAVEUSDT,LINKUSDT,UNIUSDT,ETHUSDT")
declare -A KNOB=(
 [base]=""
 [tp095]="--override-tp-mult 0.95"
 [tp105]="--override-tp-mult 1.05"
 [tp115]="--override-tp-mult 1.15"
 [votes1]="--regime-min-votes 1"
 [kelly04]="--kelly-sizing --kelly-fraction 0.40 --kelly-window 60 --kelly-min-trades 20")

n=0
for ck in "${!CFG[@]}"; do for bk in "${!BASK[@]}"; do for kk in "${!KNOB[@]}"; do
  for ph in p1 p2; do [ "$ph" = p1 ] && t=0.10 md=30 || t=0.05 md=60
    out="$O/${ck}__${bk}__${kk}__${ph}.jsonl"
    [ -s "$out" ] && continue   # resume-safe
    # shellcheck disable=SC2086
    "$SWEEP" --candles-dir "$C" --funding-dir "$C" --symbols "${BASK[$bk]}" \
      --windows 9999 --step-days 3 --threads 1 --signals regime --config "${CFG[$ck]}" \
      --strict-pass --profit-target $t --max-days $md ${KNOB[$kk]} --out "$out" >/dev/null 2>&1 &
    n=$((n+1)); while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
  done
done; done; done
wait
echo "[oos-design] done: $(ls "$O"/*.jsonl | wc -l) files"
