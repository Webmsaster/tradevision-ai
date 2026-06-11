#!/bin/bash
# 2026-05-23 Wave-3 4th-member-replacement hunt. RUBIN gives +5.21pp on
# Stack-4 (51.96→57.17) but corr +0.600 vs AMBER. Find a 4th with lower
# corr → potentially +6-8pp uplift instead of +5.21.
#
# 8 parallel P1 sweeps × --threads 2 = 16 threads (full saturation).
# Then aggregate, pick top 3 by (1-corr_with_amber) × single_rate.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/wave3_4thmember
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

BASE="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 2 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --profit-target 0.10 --max-days 30"

# 8 candidates for 4th-member replacement
CONFIGS=(
  "2h-trend-v5-titanium-passlock:titanium"
  "2h-trend-v5-obsidian-passlock:obsidian"
  "2h-trend-v5-sapphir-passlock:sapphir"
  "2h-trend-v5-amber-quartz-passlock:amber_quartz"
  "2h-trend-v5-amber-be-passlock:amber_be"
  "2h-trend-v5-amber-atr-passlock:amber_atr"
  "2h-trend-v5-amber-passlock-daystage:amber_daystage"
  "2h-trend-v5-amber-ptp-passlock:amber_ptp"
)

PIDS=()
for entry in "${CONFIGS[@]}"; do
  cfg="${entry%:*}"; tag="${entry##*:}"
  out="$OUT/${tag}_p1.jsonl"
  if [[ -f "$out" ]]; then echo "[skip] $tag"; continue; fi
  echo "[launch] $tag P1"
  ( $SWEEP $BASE --config "$cfg" --out "$out" 2>&1 | tail -1 ; echo "[done] $tag" ) > "$OUT/${tag}.log" 2>&1 &
  PIDS+=($!)
done
echo "Launched ${#PIDS[@]} parallel P1 sweeps. Waiting..."
for pid in "${PIDS[@]}"; do wait $pid; done

echo ""
echo "=== P1 results + corr-with-AMBER (binary vector) ==="
python3 - <<'EOF'
import json, os
OUT = "scripts/cache_bakeoff/wave3_4thmember"
STACK3 = "scripts/cache_bakeoff/stack3_bidir_mr"

def load(path):
    d={}
    for l in open(path):
        o=json.loads(l); d[o["win_idx"]] = (bool(o["passed"]), o.get("final_day"))
    return d

amber = load(f"{STACK3}/amber_p1.jsonl")
bidir = load(f"{STACK3}/bidir_p1.jsonl")
mr    = load(f"{STACK3}/mr_p1.jsonl")
print(f"AMBER P1 pass-rate: {100*sum(1 for v in amber.values() if v[0])/len(amber):.2f}% (n={len(amber)})")

def corr_with(ref, other_p1):
    common = sorted(set(ref) & set(other_p1))
    a = [1 if ref[k][0] else 0 for k in common]
    b = [1 if other_p1[k][0] else 0 for k in common]
    if not common: return float('nan')
    ma=sum(a)/len(a); mb=sum(b)/len(b)
    num=sum((a[i]-ma)*(b[i]-mb) for i in range(len(common)))
    da=(sum((x-ma)**2 for x in a))**0.5
    db=(sum((x-mb)**2 for x in b))**0.5
    return num/(da*db) if da>0 and db>0 else 0.0

print(f"\n{'config':<18}  {'P1%':>6}  {'corr_A':>7}  {'corr_B':>7}  {'corr_M':>7}  {'score':>7}")
print(f"{'-'*70}")
results = []
for fname in sorted(os.listdir(OUT)):
    if not fname.endswith("_p1.jsonl"): continue
    path = os.path.join(OUT, fname)
    tag = fname[:-len("_p1.jsonl")]
    rows = load(path)
    if not rows: continue
    n = len(rows); p = sum(1 for v in rows.values() if v[0]); pct = 100*p/n
    cA = corr_with(amber, rows)
    cB = corr_with(bidir, rows)
    cM = corr_with(mr,    rows)
    # diversification score = passrate × (1 - max(corrs))
    diversity = pct * (1 - max(cA, cB, cM))
    print(f"{tag:<18}  {pct:>5.2f}%  {cA:>+6.3f}  {cB:>+6.3f}  {cM:>+6.3f}  {diversity:>6.1f}")
    results.append((tag, pct, cA, cB, cM, diversity))

# RUBIN baseline for comparison
print(f"\n--- RUBIN baseline ---")
print(f"  rubin             P1 47.61%  corr_A +0.600  corr_B +0.174  corr_M +0.041  Stack-4 +5.21pp")

if results:
    by_div = sorted(results, key=lambda r: -r[5])[:3]
    print("\n=== TOP 3 by diversification score (passrate × (1-max_corr)) ===")
    for tag, pct, cA, cB, cM, div in by_div:
        print(f"  {tag:<18}  {pct:>5.2f}%  max_corr {max(cA,cB,cM):+.3f}  score {div:>5.1f}")
EOF
