#!/bin/bash
# 2026-05-23 Stack-4 RE-BASELINE with NEW per-asset costs.
#
# Old cost_bp (uniform 30/8/4) was changed in templates.rs to per-asset:
#   BTC  → 15/10/5
#   ETH  → 25/10/5
#   alts → 35/12/7
# Champion Stack-4 (AMBER+TITANIUM+BIDIR+MR PASSLOCK = 59.10%) was measured
# on OLD costs. ALL future sweeps need re-baseline.
#
# This script re-runs the 4 sister configs × 2 phases = 8 sweeps in parallel.
# Output: scripts/cache_bakeoff/stack4_rebaseline/{amber,titanium,bidir,mr}_{p1,p2}.jsonl
#
# Then aggregator script (stack4_titanium_2026_05_23.py-style) should be
# pointed at the new dir to compute the new honest Stack-4 OR.
#
# Resource budget: 8 × 2 threads = 16 threads = full CPU (16 cores).
# DO NOT start while shortsonly_sweep_2026_05_23.sh is still running
# (3 × 4 threads = 12 threads → would oversubscribe to 28 threads).

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/stack4_rebaseline
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Identical flags to stack3_bidir_mr + wave3_4thmember (for apples-to-apples).
BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 2 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --max-days 30"

# 4 configs × 2 phases (P1=+10%, P2=+5%)
# Tag → config :: profit_target
CELLS=(
  "amber:2h-trend-v5-amber-max-passlock:0.10:p1"
  "amber:2h-trend-v5-amber-max-passlock:0.05:p2"
  "titanium:2h-trend-v5-titanium-passlock:0.10:p1"
  "titanium:2h-trend-v5-titanium-passlock:0.05:p2"
  "bidir:2h-trend-v5-amber-max-passlock-bidir:0.10:p1"
  "bidir:2h-trend-v5-amber-max-passlock-bidir:0.05:p2"
  "mr:2h-trend-v5-amber-max-mr-passlock:0.10:p1"
  "mr:2h-trend-v5-amber-max-mr-passlock:0.05:p2"
)

PIDS=()
for entry in "${CELLS[@]}"; do
  tag=$(echo "$entry" | cut -d: -f1)
  cfg=$(echo "$entry" | cut -d: -f2)
  pt=$(echo "$entry" | cut -d: -f3)
  phase=$(echo "$entry" | cut -d: -f4)
  out="$OUT/${tag}_${phase}.jsonl"
  if [[ -f "$out" ]]; then echo "[skip] ${tag}_${phase} exists"; continue; fi
  echo "[launch] ${tag}_${phase} (cfg=$cfg pt=$pt)"
  ( $SWEEP $BASE --config "$cfg" --profit-target "$pt" --out "$out" 2>&1 | tail -2 ; echo "[done] ${tag}_${phase}" ) \
    > "$OUT/${tag}_${phase}.log" 2>&1 &
  PIDS+=($!)
done
echo "Launched ${#PIDS[@]} parallel sweeps. Waiting..."
for pid in "${PIDS[@]}"; do wait $pid; done

echo ""
echo "=== Per-config pass-rates (re-baselined costs) ==="
for tag in amber titanium bidir mr; do
  for phase in p1 p2; do
    f="$OUT/${tag}_${phase}.jsonl"
    if [[ ! -f "$f" ]]; then continue; fi
    n=$(wc -l < "$f")
    passed=$(python3 -c "import json; print(sum(1 for l in open('$f') if json.loads(l).get('passed')))")
    pct=$(python3 -c "print(f'{$passed/$n*100:.2f}')")
    echo "  ${tag}_${phase}: $passed/$n = $pct%"
  done
done

echo ""
echo "=== Stack-4 TRUE-SEQUENTIAL combined-funded OR (NEW costs) ==="
python3 - "$OUT" <<'EOF'
import json, sys, os
OUT = sys.argv[1]

def load(tag, phase):
    d = {}
    p = os.path.join(OUT, f"{tag}_{phase}.jsonl")
    if not os.path.exists(p): return d
    for l in open(p):
        o = json.loads(l); d[o["win_idx"]] = (bool(o["passed"]), o.get("final_day"))
    return d

tags = ["amber", "titanium", "bidir", "mr"]
P1 = {t: load(t, "p1") for t in tags}
P2 = {t: load(t, "p2") for t in tags}
if any(len(P1[t]) == 0 or len(P2[t]) == 0 for t in tags):
    print("MISSING files — abort aggregation"); sys.exit(0)

def funded(t, i, off=0):
    if i not in P1[t]: return None
    p1_pass, D = P1[t][i]
    if not p1_pass: return False
    j = i + D + off
    if j not in P2[t]: return None
    return P2[t][j][0]

allk = set(P1[tags[0]])
for t in tags[1:]: allk &= set(P1[t])
keys = sorted(allk)

for off in (0, 1):
    per = {t: 0 for t in tags}; n = 0; stack = 0; vec = {t: [] for t in tags}
    for i in keys:
        fs = {t: funded(t, i, off) for t in tags}
        if any(v is None for v in fs.values()): continue
        n += 1
        for t in tags:
            per[t] += 1 if fs[t] else 0
            vec[t].append(1 if fs[t] else 0)
        if any(fs[t] for t in tags): stack += 1
    print(f"\n--- offset={off}  n={n} ---")
    for t in tags:
        print(f"  {t:9s}  {per[t]}/{n} = {100*per[t]/n:.2f}%")
    print(f"  Stack-4 OR:  {stack}/{n} = {100*stack/n:.2f}%")
    def corr(a,b):
        na=len(a)
        if na==0: return 0.0
        ma=sum(a)/na; mb=sum(b)/na
        num=sum((a[i]-ma)*(b[i]-mb) for i in range(na))
        da=(sum((x-ma)**2 for x in a))**0.5
        db=(sum((x-mb)**2 for x in b))**0.5
        return num/(da*db) if da>0 and db>0 else 0.0
    print(f"  Pairwise corrs:")
    for i,a in enumerate(tags):
        for b in tags[i+1:]:
            print(f"    {a:9s} <-> {b:9s}  {corr(vec[a],vec[b]):+.3f}")
EOF

echo ""
echo "Compare against OLD-cost Stack-4 = 59.10% (offset=0)"
