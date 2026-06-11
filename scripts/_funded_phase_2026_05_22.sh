#!/bin/bash
# 2026-05-22 Funded-phase simulation: once you HAVE a funded account, how much
# does it earn before it busts? Champion strategy, NO reachable profit target
# (set to 100.0 = 10000% so it never "passes" / never PASSLOCK-closes), bust at
# the FTMO funded limits (-10% total via maxStopPct liveCap + daily-loss),
# over a long horizon. final_equity_pct = P&L over the funded period;
# fail_reason = TotalLoss/DailyLoss (busted) vs null/MaxDays (survived).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/funded_phase
mkdir -p "$OUT"
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMBOLS --windows 9999 --step-days 3 --threads 8 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line"

for HZ in 90 180; do
  echo "[run] funded horizon ${HZ}d (no reachable target)"
  $SWEEP $COMMON --profit-target 0.99 --max-days $HZ --out "$OUT/funded_${HZ}d.jsonl" 2>&1 | tail -1
done

echo ""
for HZ in 90 180; do
python3 - "$OUT/funded_${HZ}d.jsonl" "$HZ" <<'EOF'
import json,sys,statistics as st
rows=[json.loads(l) for l in open(sys.argv[1])]
hz=sys.argv[2]
eq=[r["final_equity_pct"] for r in rows]
busts=[r for r in rows if r["fail_reason"] in ("TotalLoss","DailyLoss")]
survived=[r for r in rows if r["fail_reason"] not in ("TotalLoss","DailyLoss")]
n=len(rows)
print(f"=== FUNDED PHASE {hz}d (n={n}) ===")
print(f"  busted (-10%/daily): {len(busts)}/{n} = {100*len(busts)/n:.1f}%   survived: {len(survived)}/{n} = {100*len(survived)/n:.1f}%")
print(f"  mean final equity:   {100*st.mean(eq):+.2f}%   median: {100*st.median(eq):+.2f}%")
print(f"  survivors mean P&L:  {100*st.mean([r['final_equity_pct'] for r in survived]):+.2f}%" if survived else "  no survivors")
pos=[e for e in eq if e>0]
print(f"  windows in profit:   {len(pos)}/{n} = {100*len(pos)/n:.1f}%")
# trader payout proxy: 80% of positive final equity (profit you could withdraw)
payout=[0.80*max(e,0) for e in eq]
print(f"  >>> E[trader payout] per funded acct = 0.80 * E[max(P&L,0)] = {100*st.mean(payout):.2f}% of account")
EOF
done
