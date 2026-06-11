#!/bin/bash
# 2026-05-23 Intra-Window Daily-Loss Throttle (IDLT) grid against the
# AMBER_MAX_PASSLOCK champion. Engine feature already exists
# (intradayDailyLossThrottle in config.rs / harness.rs:629-638) — it pauses
# NEW entries when day_pnl <= -hard_loss_threshold, continuously evaluated
# each bar. day_start resets at start of next trading day, so the gate
# auto-resumes the next day. No engine work required, only config + sweep.
#
# Compares P1 pass-rate (+10% / 30d, FTMO Challenge Phase 1) across a grid
# of hard_loss_thresholds vs the no-IDLT baseline. Soft-factor kept at 0.5.
#
# Goal: confirm or refute the +5-8pp single-account uplift estimate for
# adding an intra-window daily-loss pause-gate. Memory `kill-switch -0.5pp`
# entry was a START-of-window kill-switch (--kill-switch-hour), DIFFERENT.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/idlt_grid
mkdir -p "$OUT"
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --profit-target 0.10 --max-days 30 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass"

# Baseline reuse: already in scripts/cache_bakeoff/combined_p1p2/p1.jsonl
echo "=== baseline (no IDLT) ==="
cp scripts/cache_bakeoff/combined_p1p2/p1.jsonl "$OUT/baseline_p1.jsonl"
n=$(wc -l < "$OUT/baseline_p1.jsonl"); pass=$(python3 -c "import json; print(sum(1 for l in open('$OUT/baseline_p1.jsonl') if json.loads(l)['passed']))")
echo "baseline: $pass / $n passed = $(python3 -c "print(f'{100*$pass/$n:.2f}%')")"

# IDLT grid: hard_loss_threshold = 0.02, 0.025, 0.03, 0.035, 0.04
for thresh in 0.020 0.025 0.030 0.035 0.040; do
  tag=$(echo "$thresh" | tr '.' '_')
  echo ""
  echo "=== IDLT hard=${thresh} ==="
  $SWEEP $BASE --idl-threshold "$thresh" --idl-factor 0.5 --out "$OUT/idlt_${tag}_p1.jsonl" 2>&1 | tail -1
done

echo ""
python3 - "$OUT" <<'EOF'
import json,sys,os
OUT=sys.argv[1]
def stats(path):
    rows=[json.loads(l) for l in open(path)]
    n=len(rows); p=sum(1 for r in rows if r['passed'])
    return n, p, 100*p/n if n else 0

base_n, base_p, base_pct = stats(f"{OUT}/baseline_p1.jsonl")
print(f"\n=== AMBER_MAX_PASSLOCK + IDLT grid — P1 pass-rate (+10% / 30d) ===")
print(f"{'config':>20s}  {'pass':>5s}  {'total':>5s}  {'pct':>7s}  {'delta_pp':>8s}")
print(f"{'baseline (no IDLT)':>20s}  {base_p:>5d}  {base_n:>5d}  {base_pct:>6.2f}%      —")
for thresh in ['0.020','0.025','0.030','0.035','0.040']:
    tag = thresh.replace('.','_')
    path = f"{OUT}/idlt_{tag}_p1.jsonl"
    if not os.path.exists(path): continue
    n,p,pct = stats(path)
    delta = pct - base_pct
    print(f"{'IDLT '+thresh:>20s}  {p:>5d}  {n:>5d}  {pct:>6.2f}%  {delta:+7.2f}pp")
EOF
