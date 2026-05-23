#!/bin/bash
# 2026-05-23 Walk-forward for +8% funded burst target.
# One sweep on ALL windows, then split window-idx 50/50 into in-sample / out-of-sample
# and report burst-chain monthly profit for each half. Identical engine config to the
# in-sample +8% claim, only the eval is split by date.
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

echo "[run] +8% burst (PASSLOCK), max-days 30 per burst (walk-forward sample)"
$SWEEP $COMMON --profit-target 0.08 --max-days 30 --out "$OUT/burst_pt08.jsonl" 2>&1 | tail -1

echo ""
python3 - "$OUT/burst_pt08.jsonl" <<'EOF'
import json,sys,statistics as st
rows={}
for l in open(sys.argv[1]):
    o=json.loads(l); rows[o["win_idx"]]=(bool(o["passed"]), o["final_day"], o["fail_reason"])
ks=sorted(rows); N=len(ks)
mid=N//2
is_idx  = [k for k in ks if k < mid]      # in-sample: first half by window-idx
oos_idx = [k for k in ks if k >= mid]     # out-of-sample: second half

WITHDRAW = 0.08 * 0.80   # trader keeps 80% of the +8% per banked burst

def chain_stats(label, idx_set):
    fold = set(idx_set)
    q = sum(1 for k in idx_set if rows[k][0]) / max(1,len(idx_set))
    fd = [rows[k][1] for k in idx_set if rows[k][0]]
    med = st.median(fd) if fd else float('nan')
    results=[]
    for start in idx_set:
        i=start; banked=0; days=0
        while i in rows and i in fold:
            passed,D,fr = rows[i]
            days += D
            if passed:
                banked += 1
                i = i + D
            else:
                break
            if days > 365: break
        results.append((banked, days, banked*WITHDRAW))
    cyc=[r[0] for r in results]; pay=[r[2] for r in results]; dys=[r[1] for r in results]
    monthly=[ (r[2]/r[1]*30) for r in results if r[1]>0 ]
    print(f"\n=== {label}  (n={len(idx_set)}, win_idx range {min(idx_set)}..{max(idx_set)}) ===")
    print(f"  single burst pass-rate (+8%):  {100*q:.2f}%   median pass-day {med:.0f}")
    print(f"  avg banked +8% cycles before bust: {st.mean(cyc):.2f}   median {st.median(cyc):.0f}")
    print(f"  avg lifespan: {st.mean(dys):.0f} days   median {st.median(dys):.0f}")
    print(f"  avg trader payout:  {100*st.mean(pay):.2f}% of account   (= {st.mean(cyc):.2f} cycles * 6.4%)")
    print(f"  >>> PROFIT/MONTH (trader share):  mean {100*st.mean(monthly):.2f}%   median {100*st.median(monthly):.2f}%   stdev {100*st.pstdev(monthly):.2f}%")
    return st.mean(monthly), 100*q, st.mean(cyc)

is_mo,  is_pq,  is_cy  = chain_stats("IN-SAMPLE  (first 50% windows)",  is_idx)
oos_mo, oos_pq, oos_cy = chain_stats("OUT-OF-SAMPLE (second 50% windows)", oos_idx)

print("\n=== WALK-FORWARD VERDICT ===")
drift_mo = (oos_mo - is_mo) * 100
drift_pq = oos_pq - is_pq
print(f"  pass-rate drift  IS->OOS:  {drift_pq:+.2f}pp")
print(f"  profit/mo drift  IS->OOS:  {drift_mo:+.2f}pp absolute  ({100*(oos_mo/is_mo-1) if is_mo>0 else 0:+.1f}% relative)")
if abs(drift_mo) <= 2.0 and abs(drift_pq) <= 5.0:
    print("  -> STABLE: OOS holds within tolerance, +8% target is NOT overfit on this split")
elif drift_mo < -2.0 or drift_pq < -5.0:
    print("  -> WEAKER OOS: target may be regime-specific, investigate before live")
else:
    print("  -> STRONGER OOS: lucky split or regime improved, conservative estimate = min(IS,OOS)")
EOF
