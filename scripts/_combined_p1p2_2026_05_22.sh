#!/bin/bash
# 2026-05-22 Honest bug-free single-account COMBINED funded rate (P1 AND P2).
# Same champion config (AMBER_MAX_PASSLOCK + BNB 18/50, tp=1.10, Kelly 0.5,
# 5 voters) as the step-1 baseline. P1 = pt=0.10/30d, P2 = pt=0.05/60d.
# Per-window AND: a window counts as "funded" only if it passes BOTH phases.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/combined_p1p2
mkdir -p "$OUT"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass"

echo "[run] P1 (pt=0.10, max-days 30)"
$SWEEP $COMMON --profit-target 0.10 --max-days 30 --out "$OUT/p1.jsonl" 2>&1 | tail -2
echo "[run] P2 (pt=0.05, max-days 60)"
$SWEEP $COMMON --profit-target 0.05 --max-days 60 --out "$OUT/p2.jsonl" 2>&1 | tail -2

echo ""
python3 - "$OUT/p1.jsonl" "$OUT/p2.jsonl" <<'EOF'
import json,sys
def load(p):
    d={}
    for l in open(p):
        o=json.loads(l); d[o["win_idx"]]=bool(o["passed"])
    return d
p1=load(sys.argv[1]); p2=load(sys.argv[2])
keys=sorted(set(p1)&set(p2))   # windows where BOTH phases had enough future data
n=len(keys)
p1_pass=sum(1 for k in keys if p1[k])
p2_pass=sum(1 for k in keys if p2[k])
both=sum(1 for k in keys if p1[k] and p2[k])
cond=both/p1_pass if p1_pass else 0
print(f"windows (intersection, both phases plannable): {n}")
print(f"P1 pass-rate:            {p1_pass}/{n} = {100*p1_pass/n:.2f}%")
print(f"P2 pass-rate (marginal): {p2_pass}/{n} = {100*p2_pass/n:.2f}%")
print(f"P2 | P1 (conditional):   {both}/{p1_pass} = {100*cond:.2f}%")
print(f"COMBINED FUNDED (P1 AND P2 same window): {both}/{n} = {100*both/n:.2f}%")
print(f"(naive independent product P1*P2 = {100*(p1_pass/n)*(p2_pass/n):.2f}%)")
EOF
