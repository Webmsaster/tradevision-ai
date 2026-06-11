#!/bin/bash
# 2026-05-15 Hunt Wave 3 — Phase 2 (pt=0.05) deep tuning at the champion base.
# P2 is the easier target (59.4% baseline). Pushing P2 to 70%+ helps combined Funded most.
# Runs after Wave 1+2 finish (don't oversubscribe CPU).
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
SYMS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"
OUT=scripts/cache_bakeoff/hunt_2026_05_15
mkdir -p "$OUT"
RESULTS="$OUT/wave3_p2_results.tsv"
: > "$RESULTS"
echo -e "label\tP2_pct" >> "$RESULTS"

BASE="2h-trend-v5-amber-max-passlock"
VOTERS="--signals regime --regime-min-votes 2 --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-smc-fvg --regime-use-hmm"
COMMON="--candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff --symbols $SYMS --config $BASE --windows 1000 --step-days 1 --threads 8 --profit-target 0.05"

run() {
  local label="$1"
  shift
  local p2=$($SWEEP $COMMON $VOTERS "$@" 2>&1 | tail -1 | grep -oE '[0-9]+\.[0-9]+%' | head -1 | tr -d '%')
  if [ -z "$p2" ]; then echo "[skip] $label"; return; fi
  echo -e "$label\t$p2" | tee -a "$RESULTS"
}

# Baseline
run "BASELINE"

# tp_mult sweep
for tp in 0.50 0.60 0.65 0.70 0.75 0.80 0.85 0.90 0.95 1.05 1.10 1.20; do
  run "tp=$tp" --override-tp-mult $tp
done

# vol-mult sweep with vol-confirm on
# 2026-05-15 (Audit-Round-4 / Agent #10 KRIT): label was `vm=$vm_vc`, but
# `$vm_vc` is bash's parse of the variable name `vm_vc` (suffix `_vc` is
# valid identifier chars) → expanded to empty string → all 7 runs landed
# in the TSV with identical label "vm=" and earlier rows were clobbered.
for vm in 1.5 1.8 2.0 2.2 2.5 2.8 3.0; do
  run "vm=${vm}_vc" --regime-vol-confirm --regime-vol-mult $vm
done

# Drop symbols (low-quality assets)
for drop in "DOGEUSDT" "RUNEUSDT" "SANDUSDT" "DOGEUSDT,RUNEUSDT" "DOGEUSDT,RUNEUSDT,SANDUSDT" "ALGOUSDT" "TRXUSDT" "TRXUSDT,DOGEUSDT" "ALGOUSDT,DOGEUSDT,RUNEUSDT"; do
  run "drop=$drop" --drop-symbols "$drop"
done

# Hours filters
for hrs in "0,8,16" "8,16" "0,12" "8,12,16" "0,4,8,12,16,20"; do
  run "hours=$hrs" --override-hours "$hrs"
done

# DOWs
for dow in "1,2,3,4" "2,3,4" "0,1,2,3,4,5"; do
  run "dows=$dow" --override-dows "$dow"
done

# MCT (max concurrent trades)
for m in 3 5 7 10; do
  run "mct=$m" --override-mct $m
done

# Trail tighter
for tr in 0.001 0.0015 0.002 0.003 0.005; do
  run "trail=$tr" --override-trail-pct $tr
done

# BE threshold
for be in 0.005 0.010 0.015 0.020; do
  run "be=$be" --be-threshold $be
done

# HTF MACD gate
run "htf-macd" --use-htf-confirm

# Combination of best tp + drop
for tp in 0.65 0.80 0.95; do
  for drop in "DOGEUSDT" "DOGEUSDT,RUNEUSDT"; do
    run "tp=${tp}_drop=$drop" --override-tp-mult $tp --drop-symbols "$drop"
  done
done

# tp + vol-confirm combo
for tp in 0.65 0.80 0.95; do
  for vm in 2.0 2.5; do
    run "tp=${tp}_vm=${vm}_vc" --override-tp-mult $tp --regime-vol-confirm --regime-vol-mult $vm
  done
done

echo ""
echo "=== Wave 3 P2 TOP 15 ==="
sort -t$'\t' -k2 -rn "$RESULTS" | head -16
