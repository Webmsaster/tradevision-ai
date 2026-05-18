#!/bin/bash
# Step-2 Champion Hunter — sweeps key parameters
# Runs ~30 trials, ~2-5 min each → ~1-2.5 hours total

# No `set -e` — individual trials can fail (engine error, parse fail)
# without killing the whole hunt.
cd /home/flooe/projects/tradevision-ai

SWEEP=engine-rust/target/release/ftmo-sweep
OUT_DIR=scripts/cache_bakeoff/step2_hunt_2026_05_18
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.tsv"
if [[ ! -f "$RESULTS" ]]; then
  echo -e "tp_mult\tkelly_frac\tptp\tbreadth\tmajors\tqualified\tpass_qual\tpass_pct" > "$RESULTS"
fi

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

trial() {
  local tp_mult="$1"
  local kelly_frac="$2"
  local ptp_trigger="$3"
  local ptp_close="$4"
  local breadth="$5"
  local majors="$6"
  local label="${tp_mult}_${kelly_frac}_${ptp_trigger}-${ptp_close}_${breadth}_${majors}"

  local cmd_args=(
    --candles-dir scripts/cache_bakeoff
    --funding-dir scripts/cache_bakeoff
    --symbols "$SYMBOLS"
    --windows 334 --step-days 7 --threads 8
    --profit-target 0.05 --max-days 60
    --signals regime --regime-min-votes 2
    --regime-poc-z --regime-bb-z-mr --regime-use-supertrend
    --regime-use-hmm --regime-use-ad-line
    --cross-asset-sym BTCUSDT --cross-asset-fast 9 --cross-asset-slow 21
    --config 2h-trend-v5-amber-max-passlock
    --override-tp-mult "$tp_mult"
    --kelly-sizing --kelly-fraction "$kelly_frac"
    --kelly-window 60 --kelly-min-trades 20
    --min-initial-signal-breadth "$breadth"
    --min-initial-majors "$majors"
    --strict-pass
    --out "$OUT_DIR/$label.jsonl"
  )

  if [[ "$ptp_trigger" != "none" ]]; then
    cmd_args+=(--ptp-levels "${ptp_trigger}:${ptp_close}")
  fi

  local output
  output=$("$SWEEP" "${cmd_args[@]}" 2>&1 | tail -3)
  local qual_line
  qual_line=$(echo "$output" | grep "qualified=" || echo "")

  if [[ -n "$qual_line" ]]; then
    # Parse: qualified=66 / 73 (90.41%) — passed_of_qualified=...
    local qual=$(echo "$qual_line" | sed -E 's/.*qualified=([0-9]+) \/ [0-9]+.*/\1/')
    local qual_total=$(echo "$qual_line" | sed -E 's/.*qualified=[0-9]+ \/ ([0-9]+).*/\1/')
    local pass_qual=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=([0-9]+) \/ [0-9]+.*/\1/')
    local pass_pct=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/')

    echo -e "${tp_mult}\t${kelly_frac}\t${ptp_trigger}:${ptp_close}\t${breadth}\t${majors}\t${qual}/${qual_total}\t${pass_qual}/${qual}\t${pass_pct}" | tee -a "$RESULTS"
  else
    echo -e "${tp_mult}\t${kelly_frac}\t${ptp_trigger}:${ptp_close}\t${breadth}\t${majors}\tERR\tERR\tERR" | tee -a "$RESULTS"
  fi
}

# Baseline first
echo "=== BASELINE ==="
trial 1.14 0.5 0.08 0.25 4 3

echo ""
echo "=== TP_MULT sweep ==="
for tp in 1.00 1.05 1.10 1.20 1.30; do
  trial "$tp" 0.5 0.08 0.25 4 3
done

echo ""
echo "=== KELLY FRAC sweep ==="
for kf in 0.3 0.4 0.6 0.7; do
  trial 1.14 "$kf" 0.08 0.25 4 3
done

echo ""
echo "=== PTP sweep ==="
trial 1.14 0.5 0.04 0.25 4 3
trial 1.14 0.5 0.06 0.25 4 3
trial 1.14 0.5 0.04 0.5 4 3
trial 1.14 0.5 0.04 0.5 4 3
trial 1.14 0.5 0.10 0.5 4 3
trial 1.14 0.5 none none 4 3

echo ""
echo "=== Breadth/Majors threshold sweep ==="
trial 1.14 0.5 0.08 0.25 3 2
trial 1.14 0.5 0.08 0.25 3 3
trial 1.14 0.5 0.08 0.25 5 3
trial 1.14 0.5 0.08 0.25 5 4
trial 1.14 0.5 0.08 0.25 6 4

echo ""
echo "=== Top combos ==="
trial 1.20 0.4 0.06 0.5 4 3
trial 1.10 0.6 0.04 0.5 4 3
trial 1.05 0.3 none none 4 3
trial 1.30 0.7 0.10 0.25 5 3

echo ""
echo "=== DONE ==="
echo "Results: $RESULTS"
sort -t$'\t' -k8 -rn "$RESULTS" | head -10
