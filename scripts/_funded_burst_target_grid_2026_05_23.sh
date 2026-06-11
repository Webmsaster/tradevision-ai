#!/bin/bash
# 2026-05-23 Profit-Target Peak Hunt — find the TP that maximizes monthly
# profit on the Funded burst-chain. We know +5%→6.5%/mo and +8%→19.7%/mo
# (Funded-only). Search higher targets. Hypothesis: per-burst pass-rate
# eventually drops faster than the banking gain grows → peak somewhere.
#
# Same engine + voters + BNB-18/50 + Kelly 0.5/60/20 as the +8% WF sweep,
# only --profit-target varies. max-days kept at 30 (one bank attempt per
# burst). PASSLOCK closeAllOnTargetReached fires at the target.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/funded_target_grid
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
  --strict-pass --max-days 30"

# Reuse existing +5% (combined_p1p2 burst not stored separately) and +8%
# (funded_burst/burst_pt08.jsonl) via copy; run +6%, +10%, +12%, +15%, +20% fresh.
[[ -f scripts/cache_bakeoff/funded_burst/burst.jsonl ]] && cp scripts/cache_bakeoff/funded_burst/burst.jsonl "$OUT/burst_pt05.jsonl"
[[ -f scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl ]] && cp scripts/cache_bakeoff/funded_burst/burst_pt08.jsonl "$OUT/burst_pt08.jsonl"

for pt in 0.06 0.10 0.12 0.15 0.20; do
  tag=$(echo "$pt" | tr -d '.')
  out="$OUT/burst_pt${tag}.jsonl"
  if [[ -f "$out" ]]; then
    echo "[skip] pt=$pt — already cached"
    continue
  fi
  echo "[run] pt=$pt"
  $SWEEP $COMMON --profit-target "$pt" --out "$out" 2>&1 | tail -1
done

echo ""
python3 - "$OUT" <<'EOF'
import json,sys,os,statistics as st
OUT=sys.argv[1]
TARGETS=[0.05,0.06,0.08,0.10,0.12,0.15,0.20]

print(f"{'TP':>5s}  {'pass%':>6s}  {'med_d':>5s}  {'cyc':>5s}  {'days':>5s}  {'payout':>7s}  {'mo_mean':>8s}  {'mo_med':>7s}")
results=[]
for pt in TARGETS:
    tag=str(pt).replace(".","")
    path=f"{OUT}/burst_pt{tag}.jsonl"
    if not os.path.exists(path):
        print(f"{pt:>5.2f}  MISSING")
        continue
    rows={}
    for l in open(path):
        o=json.loads(l); rows[o["win_idx"]]=(bool(o["passed"]), o["final_day"], o["fail_reason"])
    ks=sorted(rows); n=len(ks)
    q=sum(1 for k in ks if rows[k][0])/n
    fd=[rows[k][1] for k in ks if rows[k][0]]
    med = st.median(fd) if fd else float('nan')

    WITHDRAW=pt*0.80
    chain=[]
    for start in ks:
        i=start; banked=0; days=0
        while i in rows:
            passed,D,fr=rows[i]
            days+=D
            if passed:
                banked+=1
                i=i+D
            else:
                break
            if days>365: break
        chain.append((banked, days, banked*WITHDRAW))
    cyc=[r[0] for r in chain]; pay=[r[2] for r in chain]; dys=[r[1] for r in chain]
    monthly=[ (r[2]/r[1]*30) for r in chain if r[1]>0 ]
    mean_cyc=st.mean(cyc); mean_pay=st.mean(pay)
    mean_d=st.mean([d for d in dys if d>0])
    mo_mean=100*st.mean(monthly); mo_med=100*st.median(monthly)
    print(f"{pt:>5.2f}  {100*q:>5.2f}%  {med:>5.0f}  {mean_cyc:>5.2f}  {mean_d:>5.0f}  {100*mean_pay:>6.2f}%  {mo_mean:>7.2f}%  {mo_med:>6.2f}%")
    results.append((pt, mo_mean))

if results:
    peak = max(results, key=lambda r: r[1])
    print(f"\n=== PEAK: pt={peak[0]:.2f} → {peak[1]:.2f}%/mo ===")
EOF
