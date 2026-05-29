#!/usr/bin/env bash
# DailyEquityGuardian A/B screen on the FIXED clean Stack-4 (2026-05-28 baseline).
#
# Reconstructs the lost /tmp repro and adds a --daily-equity-guardian sweep so we
# can measure whether the intraday soft-stop (force-close + halt-for-day at
# -trigger_pct MTM) lifts true-seq funded-rate above the clean 27.65% step=1
# baseline. ~97% of challenge fails = DailyLoss, so this is the last direct lever.
#
# Usage: guardian_ab_screen.sh <step_days> <windows> <out_dir> [guardian_triggers...]
#   step_days=3 windows=334  -> fast screen
#   step_days=1 windows=9999 -> reliable confirmation
# Pass guardian triggers as bare numbers, e.g. "0.025 0.030 0.035 0.040".
# A baseline (no guardian) run is ALWAYS included.
set -euo pipefail

STEP="${1:?step_days}"
WIN="${2:?windows}"
OUTDIR="${3:?out_dir}"
shift 3
TRIGGERS=("$@")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWEEP="$ROOT/engine-rust/target/release/ftmo-sweep"
CACHE="scripts/cache_bakeoff"
# 2026-05-29 speed fix: the WSL2 crash was OVERSUBSCRIPTION (threads=14 × many
# sweeps = >>16 cores → swap-thrash), NOT the core count. Safe rule:
# jobs × threads <= cores-2. Each sweep here is --threads 1, so jobs=12 on a
# 16-core box is safe and ~3× faster than the old jobs=4. Override via JOBS env.
JOBS="${JOBS:-12}"
mkdir -p "$OUTDIR"

# 4 fixed clean accounts: key | selector | symbols | per-account knob flags
ACCTS=(
  "A_diamond_l1beta_tp115|2h-trend-v5-diamond-passlock|AVAXUSDT,DOTUSDT,NEARUSDT,SOLUSDT|--override-tp-mult 1.15"
  "B_sharpetight_alt5_v1|2h-trend-v5-amber-max-passlock-sharpe-tight|AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT|--regime-min-votes 1"
  "C_diamond_defi4_v1|2h-trend-v5-diamond-passlock|AAVEUSDT,LINKUSDT,UNIUSDT,ETHUSDT|--regime-min-votes 1"
  "D_diamond_alt5_tp115|2h-trend-v5-diamond-passlock|AAVEUSDT,ARBUSDT,AVAXUSDT,NEARUSDT,SOLUSDT|--override-tp-mult 1.15"
)

run_one() {  # variant_tag, guardian_trigger_or_empty
  local tag="$1" trig="$2"
  local gflag=()
  [ -n "$trig" ] && gflag=(--daily-equity-guardian "$trig")
  local pids=()
  for spec in "${ACCTS[@]}"; do
    IFS='|' read -r key sel syms knob <<< "$spec"
    # shellcheck disable=SC2086
    for phase in p1 p2; do
      if [ "$phase" = p1 ]; then tgt=0.10; md=30; else tgt=0.05; md=60; fi
      out="$OUTDIR/${tag}__${key}__${phase}.jsonl"
      "$SWEEP" --candles-dir "$CACHE" --funding-dir "$CACHE" \
        --symbols "$syms" --windows "$WIN" --step-days "$STEP" --threads 1 \
        --signals regime --config "$sel" --strict-pass \
        --profit-target "$tgt" --max-days "$md" $knob "${gflag[@]}" \
        --out "$out" > "$OUTDIR/${tag}__${key}__${phase}.log" 2>&1 &
      pids+=($!)
      # throttle: never exceed JOBS concurrent sweeps
      while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
    done
  done
  wait
  # audit (stack-OR true-seq)
  python3 "$ROOT/scripts/true_seq_stack_audit.py" \
    "A=$OUTDIR/${tag}__A_diamond_l1beta_tp115__p1.jsonl,$OUTDIR/${tag}__A_diamond_l1beta_tp115__p2.jsonl" \
    "B=$OUTDIR/${tag}__B_sharpetight_alt5_v1__p1.jsonl,$OUTDIR/${tag}__B_sharpetight_alt5_v1__p2.jsonl" \
    "C=$OUTDIR/${tag}__C_diamond_defi4_v1__p1.jsonl,$OUTDIR/${tag}__C_diamond_defi4_v1__p2.jsonl" \
    "D=$OUTDIR/${tag}__D_diamond_alt5_tp115__p1.jsonl,$OUTDIR/${tag}__D_diamond_alt5_tp115__p2.jsonl" \
    --step-days "$STEP" --phase-gap-days 1 > "$OUTDIR/${tag}__audit.txt" 2>&1
  echo "=== ${tag} (guardian='${trig:-none}') ==="
  grep -E ">=1 funded|true-seq funded" "$OUTDIR/${tag}__audit.txt"
}

echo "[guardian-ab] step=$STEP windows=$WIN jobs=$JOBS triggers='${TRIGGERS[*]:-}' out=$OUTDIR"
run_one "baseline" ""
for t in "${TRIGGERS[@]}"; do
  run_one "g${t}" "$t"
done
echo "[guardian-ab] DONE. Stack-OR comparison:"
for f in "$OUTDIR"/*__audit.txt; do
  tag="$(basename "$f" __audit.txt)"
  printf '%-12s ' "$tag"
  grep -E ">=1 funded" "$f" | sed 's/^ *//'
done
