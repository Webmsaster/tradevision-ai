#!/bin/bash
# 2026-05-23 Wave-1 RUN-verdict batch. 4 sweeps × --threads 2 = 8 threads total.
# Each sweep writes JSONL into its own subdir. Aggregator runs at the end.
#
# Routes:
#   P1: max-days × TP grid (pt={0.10,0.12,0.15} × md={45,60,90})  → 9 cells
#   R2: BNB cross-asset period grid {12/30, 18/50, 24/60, 30/80}  → 4 cells
#   R3: VWAP-trend voter add-on (single cell)                     → 1 cell
#   R8: cb_premium voter add-on (single cell)                     → 1 cell
#
# Baselines for comparison:
#   P1 at +10%/30d strict: 52.35% (combined_p1p2/p1.jsonl)
#   +8% Funded burst median profit/mo: 27.43%

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/wave1_runs_2026_05_23
mkdir -p "$OUT/p1_maxdays_tp" "$OUT/r2_bnb_grid" "$OUT/r3_vwap" "$OUT/r8_cbprem"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# Shared champion args (each route adds its own knobs)
BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 2 \
  --signals regime --regime-min-votes 2 \
  --config 2h-trend-v5-amber-max-passlock \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass"

# === P1: max-days × TP grid (9 cells, Funded burst context) =================
P1_OUT="$OUT/p1_maxdays_tp"
( set -e
  for pt in 0.10 0.12 0.15; do
    for md in 45 60 90; do
      tag="pt$(echo $pt|tr -d '.')_md${md}"
      out="$P1_OUT/burst_${tag}.jsonl"
      [[ -f "$out" ]] && { echo "[P1 skip] $tag"; continue; }
      echo "[P1 run] $tag"
      $SWEEP $BASE --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
        --profit-target "$pt" --max-days "$md" --out "$out" 2>&1 | tail -1
    done
  done
  echo "[P1 done]"
) > "$P1_OUT/run.log" 2>&1 &
P1_PID=$!

# === R2: BNB period grid (4 cells, P1 +10%/30d) ============================
R2_OUT="$OUT/r2_bnb_grid"
( set -e
  for FS in "12 30" "18 50" "24 60" "30 80"; do
    F=${FS% *}; S=${FS#* }
    out="$R2_OUT/bnb_${F}_${S}.jsonl"
    [[ -f "$out" ]] && { echo "[R2 skip] bnb_${F}_${S}"; continue; }
    echo "[R2 run] bnb_${F}_${S}"
    $SWEEP $BASE --cross-asset-sym BNBUSDT --cross-asset-fast "$F" --cross-asset-slow "$S" \
      --profit-target 0.10 --max-days 30 --out "$out" 2>&1 | tail -1
  done
  echo "[R2 done]"
) > "$R2_OUT/run.log" 2>&1 &
R2_PID=$!

# === R3: VWAP-trend voter add-on ===========================================
R3_OUT="$OUT/r3_vwap"
( set -e
  out="$R3_OUT/add_vwap_trend.jsonl"
  if [[ ! -f "$out" ]]; then
    echo "[R3 run] vwap_trend"
    $SWEEP $BASE --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
      --regime-vwap-trend --profit-target 0.10 --max-days 30 \
      --out "$out" 2>&1 | tail -1
  fi
  echo "[R3 done]"
) > "$R3_OUT/run.log" 2>&1 &
R3_PID=$!

# === R8: cb_premium voter add-on ===========================================
R8_OUT="$OUT/r8_cbprem"
( set -e
  out="$R8_OUT/add_cb_premium.jsonl"
  if [[ ! -f "$out" ]]; then
    echo "[R8 run] cb_premium"
    $SWEEP $BASE --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
      --regime-use-cb-premium --cb-premium-dir scripts/cache_bakeoff \
      --profit-target 0.10 --max-days 30 \
      --out "$out" 2>&1 | tail -1
  fi
  echo "[R8 done]"
) > "$R8_OUT/run.log" 2>&1 &
R8_PID=$!

echo "Launched: P1=$P1_PID  R2=$R2_PID  R3=$R3_PID  R8=$R8_PID"
wait $P1_PID && echo "P1 finished"
wait $R2_PID && echo "R2 finished"
wait $R3_PID && echo "R3 finished"
wait $R8_PID && echo "R8 finished"

echo ""
echo "=== AGGREGATION ==="
python3 - "$OUT" <<'EOF'
import json, os, statistics as st, glob

OUT = __import__('sys').argv[1]
BASELINE_P1 = 52.35   # +10%/30d AMBER_MAX_PASSLOCK + BNB 18/50, n=1022

def stats(path):
    rows = [json.loads(l) for l in open(path)]
    n = len(rows); p = sum(1 for r in rows if r['passed'])
    return n, p, 100*p/n if n else 0

def burst_chain(rows_dict, pt):
    WITHDRAW = pt*0.80
    chain=[]
    ks=sorted(rows_dict)
    for start in ks:
        i=start; banked=0; days=0
        while i in rows_dict:
            passed, D, fr = rows_dict[i]
            days += D
            if passed:
                banked += 1; i = i+D
            else:
                break
            if days>365: break
        chain.append((banked, days, banked*WITHDRAW))
    monthly = [(r[2]/r[1]*30) for r in chain if r[1]>0]
    if not monthly: return 0,0,0
    return 100*st.median(monthly), 100*st.mean(monthly), 100*sorted(monthly)[3*len(monthly)//4]

# R2 BNB grid
print("\n--- R2: BNB period grid (P1 +10%/30d) ---")
print(f"{'config':>12}  {'pass%':>7}  {'Δ vs 18/50':>10}")
for FS in [(12,30),(18,50),(24,60),(30,80)]:
    F,S=FS
    path=f"{OUT}/r2_bnb_grid/bnb_{F}_{S}.jsonl"
    if not os.path.exists(path): continue
    n,p,pct=stats(path)
    delta = pct - 52.35
    print(f"  bnb_{F}_{S:<3}  {pct:>6.2f}%  {delta:>+6.2f}pp")

# R3 / R8 voter additions
print("\n--- R3 + R8: voter add-ons (P1 +10%/30d) ---")
for tag,path in [
    ("baseline (no add)", "scripts/cache_bakeoff/combined_p1p2/p1.jsonl"),
    ("+ vwap_trend",   f"{OUT}/r3_vwap/add_vwap_trend.jsonl"),
    ("+ cb_premium",   f"{OUT}/r8_cbprem/add_cb_premium.jsonl"),
]:
    if not os.path.exists(path): print(f"  {tag:<22}  MISSING"); continue
    n,p,pct=stats(path)
    delta = pct - 52.35
    print(f"  {tag:<22}  {pct:>6.2f}%  {delta:>+6.2f}pp")

# P1 max-days × TP grid → burst-chain profit
print("\n--- P1: max-days × TP grid (Funded burst, monthly profit/mo) ---")
print(f"{'pt':>5}  {'md':>4}  {'pass%':>7}  {'med_mo':>7}  {'mean_mo':>8}  {'p75_mo':>7}")
for pt_str in ["010","012","015"]:
    pt = int(pt_str)/100.0
    for md in [45,60,90]:
        path=f"{OUT}/p1_maxdays_tp/burst_pt{pt_str}_md{md}.jsonl"
        if not os.path.exists(path): continue
        rows={}
        for l in open(path):
            o=json.loads(l); rows[o["win_idx"]] = (bool(o["passed"]), o["final_day"], o["fail_reason"])
        med, mean, p75 = burst_chain(rows, pt)
        n,p,pct = stats(path)
        print(f"  {pt:>5.2f}  {md:>4}  {pct:>6.2f}%  {med:>6.2f}%  {mean:>7.2f}%  {p75:>6.2f}%")

print("\n--- BASELINE FOR COMPARISON ---")
print(f"  Champion at pt=0.08 / md=30: pass 56.11%  med-mo 27.43%  mean-mo 20.93%  p75-mo 38.40%")
EOF
