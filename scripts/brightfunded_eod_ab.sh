#!/usr/bin/env bash
# BrightFunded vs FTMO A/B on the FIXED clean Stack-4 (2026-05-28 baseline).
#
# Measures the honest funded-rate uplift from a softer End-of-Day DailyLoss
# rule (BrightFunded-style) vs FTMO's real-time intraday DailyLoss. Same engine,
# same templates, same windows — the ONLY difference is `--daily-loss-eod`,
# which evaluates the -5% daily floor on each day's CLOSING equity instead of
# intraday. ~97% of FTMO fails are DailyLoss, so this isolates exactly the lever
# a firm-switch buys us. The hard -10% TotalLoss floor stays intraday in both.
#
# Usage: brightfunded_eod_ab.sh <step_days> <windows> <out_dir>
#   step_days=3 windows=334  -> fast screen
#   step_days=1 windows=9999 -> reliable confirmation (matches the 27.65% base)
set -euo pipefail

STEP="${1:?step_days}"
WIN="${2:?windows}"
OUTDIR="${3:?out_dir}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWEEP="$ROOT/engine-rust/target/release/ftmo-sweep"
CACHE="scripts/cache_bakeoff"
JOBS=4          # throttled: WSL2 box crashes under heavy parallel sweeps
mkdir -p "$OUTDIR"

# 4 fixed clean accounts: key | selector | symbols | per-account knob flags
ACCTS=(
  "A_diamond_l1beta_tp115|2h-trend-v5-diamond-passlock|AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT|--override-tp-mult 1.15"
  "B_sharpetight_alt5_v1|2h-trend-v5-amber-max-passlock-sharpe-tight|AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT|--regime-min-votes 1"
  "C_diamond_defi4_v1|2h-trend-v5-diamond-passlock|AAVEUSDT,LINKUSDT,UNIUSDT,ETHUSDT|--regime-min-votes 1"
  "D_diamond_alt5_tp115|2h-trend-v5-diamond-passlock|AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT|--override-tp-mult 1.15"
)

run_one() {  # variant_tag, extra_flags...
  local tag="$1"; shift
  local extra=("$@")
  for spec in "${ACCTS[@]}"; do
    IFS='|' read -r key sel syms knob <<< "$spec"
    for phase in p1 p2; do
      if [ "$phase" = p1 ]; then tgt=0.10; md=30; else tgt=0.05; md=60; fi
      out="$OUTDIR/${tag}__${key}__${phase}.jsonl"
      # shellcheck disable=SC2086
      "$SWEEP" --candles-dir "$CACHE" --funding-dir "$CACHE" \
        --symbols "$syms" --windows "$WIN" --step-days "$STEP" --threads 1 \
        --signals regime --config "$sel" --strict-pass \
        --profit-target "$tgt" --max-days "$md" $knob "${extra[@]}" \
        --out "$out" > "$OUTDIR/${tag}__${key}__${phase}.log" 2>&1 &
      while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
    done
  done
  wait
  python3 "$ROOT/scripts/true_seq_stack_audit.py" \
    "A=$OUTDIR/${tag}__A_diamond_l1beta_tp115__p1.jsonl,$OUTDIR/${tag}__A_diamond_l1beta_tp115__p2.jsonl" \
    "B=$OUTDIR/${tag}__B_sharpetight_alt5_v1__p1.jsonl,$OUTDIR/${tag}__B_sharpetight_alt5_v1__p2.jsonl" \
    "C=$OUTDIR/${tag}__C_diamond_defi4_v1__p1.jsonl,$OUTDIR/${tag}__C_diamond_defi4_v1__p2.jsonl" \
    "D=$OUTDIR/${tag}__D_diamond_alt5_tp115__p1.jsonl,$OUTDIR/${tag}__D_diamond_alt5_tp115__p2.jsonl" \
    --step-days "$STEP" --phase-gap-days 1 > "$OUTDIR/${tag}__audit.txt" 2>&1
}

echo "[bf-ab] step=$STEP windows=$WIN jobs=$JOBS out=$OUTDIR"
# Decompose the firm-switch effect:
#   ftmo_intraday    = FTMO baseline (day-start floor, intraday, close-based TL)
#   bf_hwm           = BrightFunded daily floor (prev-EoD-HWM, still intraday)
#   bf_hwm_intrabar  = + honest intra-bar TL check  ← the faithful BrightFunded model
run_one "ftmo_intraday"
run_one "bf_hwm" --daily-loss-eod-hwm
run_one "bf_hwm_intrabar" --daily-loss-eod-hwm --intrabar-dd-check
echo "[bf-ab] DONE. Stack-OR + per-account:"
for tag in ftmo_intraday bf_hwm bf_hwm_intrabar; do
  echo "=== $tag ==="
  grep -E ">=1 funded|true-seq funded" "$OUTDIR/${tag}__audit.txt"
done
