#!/bin/bash
# 2026-05-23 MR-tuning hunt. MR is the weakest stack member (16.15% single
# combined-funded). Wave-3 agents confirmed engine-default values were NEVER
# explicitly tuned. All CLI flags exist (--mr-oversold/overbought/period/
# cooldown/size-mult). 7 parallel sweeps × --threads 2 = 14 threads.
#
# Grids tested in parallel (single-axis A/B against baseline):
#   RSI thresholds: {20/80, 25/75 baseline, 30/70}
#   cooldown:       {8 baseline, 16, 24, 32}
#   sizeMult:       {0.5 baseline, 0.7, 1.0}
#   MR-friendly basket (drop top-5 trend assets): 1 cell
#   MR-friendly voters (drop supertrend/ad-line): 1 cell
#
# After done, aggregate winners → potentially baked into v5_amber_max_mr_passlock.

set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/mr_tuning_2026_05_23
mkdir -p "$OUT"
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

# MR uses --signals regime + same voters as AMBER stack (current baseline)
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff \
  --symbols $SYMS --windows 9999 --step-days 1 --threads 2 \
  --signals regime --regime-min-votes 2 \
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50 \
  --override-tp-mult 1.10 --kelly-sizing --kelly-fraction 0.5 \
  --kelly-window 60 --kelly-min-trades 20 \
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line \
  --strict-pass --profit-target 0.10 --max-days 30 \
  --config 2h-trend-v5-amber-max-mr-passlock"

PIDS=()

# Cell 1: RSI 20/80 (tighter)
( $SWEEP $COMMON --mr-oversold 20 --mr-overbought 80 --out "$OUT/mr_rsi2080_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_rsi2080.txt" 2>&1 &
PIDS+=($!)

# Cell 2: RSI 30/70 (looser)
( $SWEEP $COMMON --mr-oversold 30 --mr-overbought 70 --out "$OUT/mr_rsi3070_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_rsi3070.txt" 2>&1 &
PIDS+=($!)

# Cell 3: cooldown 16
( $SWEEP $COMMON --mr-cooldown 16 --out "$OUT/mr_cd16_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_cd16.txt" 2>&1 &
PIDS+=($!)

# Cell 4: cooldown 24
( $SWEEP $COMMON --mr-cooldown 24 --out "$OUT/mr_cd24_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_cd24.txt" 2>&1 &
PIDS+=($!)

# Cell 5: sizeMult 0.7
( $SWEEP $COMMON --mr-size-mult 0.7 --out "$OUT/mr_sm07_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_sm07.txt" 2>&1 &
PIDS+=($!)

# Cell 6: sizeMult 1.0
( $SWEEP $COMMON --mr-size-mult 1.0 --out "$OUT/mr_sm10_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_sm10.txt" 2>&1 &
PIDS+=($!)

# Cell 7: MR-friendly basket (drop top-5 trend assets BTC/ETH/BNB/SOL/AVAX)
( $SWEEP $COMMON --drop-symbols BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,AVAXUSDT --out "$OUT/mr_basket_norange_p1.jsonl" 2>&1 | tail -1 ) > "$OUT/log_basket.txt" 2>&1 &
PIDS+=($!)

echo "Launched ${#PIDS[@]} parallel MR-tuning sweeps. Waiting..."
for pid in "${PIDS[@]}"; do wait $pid; done

echo ""
echo "=== MR-tuning results (P1 +10%/30d, baseline = ~30% single-account P1) ==="
python3 - <<'EOF'
import json, os
OUT = "scripts/cache_bakeoff/mr_tuning_2026_05_23"
STACK3 = "scripts/cache_bakeoff/stack3_bidir_mr"

# baseline (current MR config, no tuning)
def stats(path):
    rows = [json.loads(l) for l in open(path)]
    n = len(rows); p = sum(1 for r in rows if r['passed'])
    return n, p, 100*p/n if n else 0

print(f"{'cell':<25}  {'n':>5}  {'pass':>5}  {'pct':>7}  {'Δ vs baseline':>14}")
print(f"{'-'*70}")

# baseline = MR P1 from existing stack3 sweep
base_n, base_p, base_pct = stats(f"{STACK3}/mr_p1.jsonl")
print(f"{'baseline (mr default)':<25}  {base_n:>5}  {base_p:>5}  {base_pct:>6.2f}%  {'—':>13}")

for fname in sorted(os.listdir(OUT)):
    if not fname.endswith("_p1.jsonl") or fname == "mr_p1.jsonl": continue
    path = os.path.join(OUT, fname)
    if not os.path.exists(path): continue
    tag = fname[:-len("_p1.jsonl")]
    n, p, pct = stats(path)
    delta = pct - base_pct
    flag = " ⭐" if delta >= 2 else (" ✓" if delta >= 0.5 else "")
    print(f"{tag:<25}  {n:>5}  {p:>5}  {pct:>6.2f}%  {delta:+13.2f}pp{flag}")
EOF
