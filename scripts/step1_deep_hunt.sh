#!/bin/bash
# Deep Step-1 hunt: validate stricter breadth/majors on larger sample,
# plus explore tp_mult > 1.30 plateau and additional voter combos.
cd /home/flooe/projects/tradevision-ai

SWEEP=engine-rust/target/release/ftmo-sweep
OUT_DIR=scripts/cache_bakeoff/step1_deep_2026_05_18
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.tsv"
if [[ ! -f "$RESULTS" ]]; then
  echo -e "label\ttp_mult\tkelly\tptp\tbreadth\tmajors\textra\tqualified\tpass_qual\tpass_pct" > "$RESULTS"
fi

SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,TRXUSDT,UNIUSDT,XRPUSDT"

trial() {
  local lbl="$1"; local tp_mult="$2"; local kelly="$3"; local ptp_t="$4"; local ptp_c="$5"
  local breadth="$6"; local majors="$7"; local extra="${8:-}"

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
    --kelly-sizing --kelly-fraction "$kelly"
    --kelly-window 60 --kelly-min-trades 20
    --min-initial-signal-breadth "$breadth" --min-initial-majors "$majors"
    --strict-pass
    --out "$OUT_DIR/$lbl.jsonl"
  )
  if [[ "$ptp_t" != "none" ]]; then
    cmd_args+=(--ptp-levels "${ptp_t}:${ptp_c}")
  fi
  # Add extra flags
  if [[ -n "$extra" ]]; then
    for arg in $extra; do
      cmd_args+=("$arg")
    done
  fi

  local output qual_line
  output=$("$SWEEP" "${cmd_args[@]}" 2>&1 | tail -3)
  qual_line=$(echo "$output" | grep "qualified=" || echo "")

  if [[ -n "$qual_line" ]]; then
    local qual_total=$(echo "$qual_line" | sed -E 's/.*qualified=[0-9]+ \/ ([0-9]+).*/\1/')
    local qual_count=$(echo "$qual_line" | sed -E 's/.* — passed_of_qualified=[0-9]+ \/ ([0-9]+).*/\1/')
    local pas=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=([0-9]+) \/ [0-9]+.*/\1/')
    local pct=$(echo "$qual_line" | sed -E 's/.*passed_of_qualified=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/')
    echo -e "${lbl}\t${tp_mult}\t${kelly}\t${ptp_t}:${ptp_c}\t${breadth}\t${majors}\t${extra}\t${qual_count}/${qual_total}\t${pas}/${qual_count}\t${pct}" | tee -a "$RESULTS"
  fi
}

echo "=== Baseline + step=3d for bigger sample ==="
trial baseline_3d 1.14 0.5 0.08 0.25 4 3 ""

# Step=3d gives ~3× more windows for stricter filters
trial step3d_5_4 1.14 0.5 0.08 0.25 5 4 ""
trial step3d_5_3 1.14 0.5 0.08 0.25 5 3 ""
trial step3d_6_4 1.14 0.5 0.08 0.25 6 4 ""

echo ""
echo "=== TP_MULT > 1.30 exploration ==="
trial high_tp_1.35 1.35 0.7 0.08 0.25 4 3 ""
trial high_tp_1.40 1.40 0.7 0.08 0.25 4 3 ""
trial high_tp_1.50 1.50 0.7 0.08 0.25 4 3 ""

echo ""
echo "=== Extra voter combos ==="
trial vol_confirm 1.14 0.5 0.08 0.25 4 3 "--regime-vol-confirm --regime-vol-mult 1.5"
trial vwap_trend 1.14 0.5 0.08 0.25 4 3 "--regime-vwap-trend"
trial ofi 1.14 0.5 0.08 0.25 4 3 "--regime-ofi"

echo ""
echo "=== Increased min-votes ==="
trial votes3 1.14 0.5 0.08 0.25 4 3 "--regime-min-votes 3"

echo ""
echo "=== Combined champion candidates ==="
trial top1 1.30 0.7 0.08 0.5 5 3 ""
trial top2 1.40 0.5 0.08 0.25 4 3 ""
trial top3 1.20 0.5 0.08 0.25 4 3 ""
trial top4 1.30 0.6 0.08 0.25 5 3 ""

echo ""
echo "=== Step-1 DEEP TOP-10 ==="
sort -t$'\t' -k10 -rn "$RESULTS" | head -10 | column -t -s$'\t'
