#!/bin/bash
# Step-1 Champion Hunter — same as Step-2 but pt=0.10 / max_days=30
cd /home/flooe/projects/tradevision-ai

SWEEP=engine-rust/target/release/ftmo-sweep
OUT_DIR=scripts/cache_bakeoff/step1_hunt_2026_05_18
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.tsv"
if [[ ! -f "$RESULTS" ]]; then
  echo -e "tp_mult\tkelly_frac\tptp\tbreadth\tmajors\tqualified\tpass_qual\tpass_pct" > "$RESULTS"
fi

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

trial() {
  local tp_mult="$1"; local kelly_frac="$2"; local ptp_trigger="$3"; local ptp_close="$4"
  local breadth="$5"; local majors="$6"
  local label="${tp_mult}_${kelly_frac}_${ptp_trigger}-${ptp_close}_${breadth}_${majors}"

  local cmd_args=(
    --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff
    --symbols "$SYMBOLS" --windows 334 --step-days 7 --threads 8
    --profit-target 0.10 --max-days 30
    --signals regime --regime-min-votes 2
    --regime-poc-z --regime-bb-z-mr --regime-use-supertrend
    --regime-use-hmm --regime-use-ad-line
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21
    --config 2h-trend-v5-amber-max-passlock
    --override-tp-mult "$tp_mult"
    --kelly-sizing --kelly-fraction "$kelly_frac"
    --kelly-window 60 --kelly-min-trades 20
    --min-initial-signal-breadth "$breadth" --min-initial-majors "$majors"
    --strict-pass
    --out "$OUT_DIR/$label.jsonl"
  )
  if [[ "$ptp_trigger" != "none" ]]; then
    cmd_args+=(--ptp-levels "${ptp_trigger}:${ptp_close}")
  fi

  local output qual_line
  output=$("$SWEEP" "${cmd_args[@]}" 2>&1 | tail -3)
  qual_line=$(echo "$output" | grep "qualified=" || echo "")

  if [[ -n "$qual_line" ]]; then
    local qual=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=([0-9]+) \/ [0-9]+.*/\1/')
    local qual_total=$(echo "$qual_line" | sed -E 's/.*qualified=[0-9]+ \/ ([0-9]+).*/\1/')
    local qual_count=$(echo "$qual_line" | sed -E 's/.* — passed_of_qualified=[0-9]+ \/ ([0-9]+).*/\1/')
    local pass_pct=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/')
    echo -e "${tp_mult}\t${kelly_frac}\t${ptp_trigger}:${ptp_close}\t${breadth}\t${majors}\t${qual_count}/${qual_total}\t${qual}/${qual_count}\t${pass_pct}" | tee -a "$RESULTS"
  fi
}

echo "=== BASELINE ==="
trial 1.14 0.5 0.08 0.25 4 3

echo "=== TP_MULT (Step-2 winner=1.30, try around) ==="
for tp in 1.00 1.05 1.10 1.20 1.25 1.30 1.35 1.40 1.50; do
  trial "$tp" 0.5 0.08 0.25 4 3
done

echo "=== KELLY FRAC (Step-2 winner=0.7) ==="
for kf in 0.3 0.4 0.6 0.7 0.8; do
  trial 1.30 "$kf" 0.08 0.25 4 3
done

echo "=== PTP variants ==="
trial 1.30 0.7 0.04 0.25 4 3
trial 1.30 0.7 0.06 0.25 4 3
trial 1.30 0.7 0.06 0.5 4 3
trial 1.30 0.7 0.10 0.25 4 3
trial 1.30 0.7 0.10 0.5 4 3
trial 1.30 0.7 0.04 0.5 4 3
trial 1.30 0.7 none none 4 3

echo "=== Breadth/Majors threshold ==="
trial 1.30 0.7 0.08 0.25 3 2
trial 1.30 0.7 0.08 0.25 3 3
trial 1.30 0.7 0.08 0.25 5 3
trial 1.30 0.7 0.08 0.25 5 4
trial 1.30 0.7 0.08 0.25 6 4

echo "=== Top combos (mirror step-2 champion) ==="
trial 1.30 0.7 0.08 0.25 4 3
trial 1.30 0.8 0.08 0.25 4 3
trial 1.35 0.7 0.08 0.5 4 3
trial 1.32 0.6 0.10 0.25 5 3

echo ""
echo "=== STEP-1 TOP-10 ==="
sort -t$'\t' -k8 -rn "$RESULTS" | head -10 | column -t -s$'\t'
