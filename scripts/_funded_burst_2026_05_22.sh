#!/bin/bash
# 2026-05-22 Funded BURST-withdrawal model -> monthly profit estimate.
# Each burst: champion + PASSLOCK closes all at +5% (= withdraw point), bust at
# -10%/daily. Chain bursts on real data (next burst starts when the previous one
# banked, at win_idx+final_day) until a burst busts. -> avg banked cycles, days,
# and profit/month. PASSLOCK config => closeAllOnTargetReached fires at pt=0.05.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/funded_burst
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
  --strict-pass"

echo "[run] +5% burst (PASSLOCK), max-days 30 per burst"
$SWEEP $COMMON --profit-target 0.05 --max-days 30 --out "$OUT/burst.jsonl" 2>&1 | tail -1

echo ""
python3 - "$OUT/burst.jsonl" <<'EOF'
import json,sys,statistics as st
rows={}
for l in open(sys.argv[1]):
    o=json.loads(l); rows[o["win_idx"]]=(bool(o["passed"]), o["final_day"], o["fail_reason"])
ks=sorted(rows)
q=sum(1 for k in ks if rows[k][0])/len(ks)
fd=[rows[k][1] for k in ks if rows[k][0]]
print(f"single burst: pass(+5%)={100*q:.1f}%  (n={len(ks)})  median pass-day={st.median(fd):.0f}")

WITHDRAW=0.05*0.80  # trader keeps 80% of the +5%
results=[]  # (banked_cycles, total_days, payout_pct)
for start in ks:
    i=start; banked=0; days=0
    while i in rows:
        passed,D,fr=rows[i]
        days+=D
        if passed:
            banked+=1
            i=i+D            # next burst starts when this one banked
        else:
            break            # busted -> account lost
        if days>365: break   # cap one year per funded account
    results.append((banked, days, banked*WITHDRAW))
import statistics as st
cyc=[r[0] for r in results]; pay=[r[2] for r in results]; dys=[r[1] for r in results]
mean_cyc=st.mean(cyc); mean_pay=st.mean(pay); mean_days=st.mean([d for d in dys if d>0])
print(f"\n=== BURST-CHAIN per funded account (n={len(results)}) ===")
print(f"  avg banked +5% cycles before bust: {mean_cyc:.2f}  (median {st.median(cyc):.0f})")
print(f"  avg lifespan: {mean_days:.0f} days")
print(f"  avg trader payout: {100*mean_pay:.2f}% of account  (= {mean_cyc:.2f} cycles * 4%)")
# monthly: payout over lifespan, scaled to 30 days
monthly=[ (r[2]/r[1]*30) for r in results if r[1]>0 ]
print(f"  >>> avg PROFIT/MONTH (trader share): {100*st.mean(monthly):.2f}% of account")
print(f"      median profit/month: {100*st.median(monthly):.2f}%")
EOF
