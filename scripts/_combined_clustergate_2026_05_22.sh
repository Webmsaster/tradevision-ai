#!/bin/bash
# 2026-05-22 Honest CLUSTER-GATE (lookahead-safe) single-account combined rate.
# Uses --cluster-only-mode (trailing 24h breadth/majors gate, mirrors the live
# executor's check_cluster_entry_block — NOT the forward-looking qualified_at_start
# report metric that was lookahead-debunked). Champion AMBER_MAX_PASSLOCK + BNB.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/combined_clustergate
mkdir -p "$OUT"

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

GATE="--cluster-only-mode --min-initial-signal-breadth 4 --min-initial-majors 3 \
  --initial-window-hours 24 --majors-list BTC,ETH,BNB,SOL"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS \
  --windows 9999 --step-days 1 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  $GATE --strict-pass"

echo "[run] P1 cluster-gated (pt=0.10, max-days 30)"
$SWEEP $COMMON --profit-target 0.10 --max-days 30 --out "$OUT/p1.jsonl" 2>&1 | tail -2
echo "[run] P2 cluster-gated (pt=0.05, max-days 60)"
$SWEEP $COMMON --profit-target 0.05 --max-days 60 --out "$OUT/p2.jsonl" 2>&1 | tail -2

echo ""
python3 - "$OUT/p1.jsonl" "$OUT/p2.jsonl" <<'EOF'
import json,sys
p1={}; p2={}
for l in open(sys.argv[1]):
    o=json.loads(l); p1[o["win_idx"]]=(bool(o["passed"]), o["final_day"])
for l in open(sys.argv[2]):
    o=json.loads(l); p2[o["win_idx"]]=bool(o["passed"])
ks=sorted(set(p1)&set(p2))
n=len(ks); p1p=sum(1 for k in ks if p1[k][0]); p2p=sum(1 for k in ks if p2[k])
print(f"windows: {n}")
print(f"P1 (cluster-gated): {p1p}/{n} = {100*p1p/n:.2f}%")
print(f"P2 marginal:        {p2p}/{n} = {100*p2p/n:.2f}%")
# true sequential
allp1=sorted(p1); ne=0; pp=0; sf=0
for i in allp1:
    passed,D=p1[i]; j=i+D
    if j not in p2: continue
    ne+=1
    if passed:
        pp+=1
        if p2[j]: sf+=1
print(f"P2|P1 TRUE sequential: {sf}/{pp} = {100*sf/pp:.2f}%" if pp else "no P1 pass")
print(f">>> CLUSTER-GATE COMBINED FUNDED (sequential): {sf}/{ne} = {100*sf/ne:.2f}%")
EOF
