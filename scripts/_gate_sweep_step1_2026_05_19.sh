#!/bin/bash
# 2026-05-19 Honest step=1 start-gate breadth/majors sweep.
#
# Champion baseline: Basket-18 + BNB 18/50 + tp=1.10 + Kelly 0.5 + 5 voters
#   (config = 2h-trend-v5-amber-max-passlock).
#
# Round 2 had measured the gate at step=7. This re-runs at step=1 for a fully
# honest sample (n ~ 1019 windows). Reports conditional (passed_of_qualified)
# AND unconditional (passed_of_total) rates per gate combo.
set -euo pipefail
cd "$(dirname "$0")/.."

SWEEP=./engine-rust/target/release/ftmo-sweep
OUT=scripts/cache_bakeoff/gate_sweep_step1_2026_05_19
RESULTS="$OUT/results.tsv"
mkdir -p "$OUT"
: > "$RESULTS"
printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
  "label" "breadth" "majors" "qualified" "total" "cond_pct" "uncond_pct" "qual_share" \
  >> "$RESULTS"

# Basket-18 (drop TRX, per Round 3 Asset Optimizer)
SYMBOLS="AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT"

COMMON_ARGS=(
  --candles-dir scripts/cache_bakeoff --funding-dir scripts/cache_bakeoff
  --symbols "$SYMBOLS"
  --windows 9999 --step-days 1 --threads 14
  --profit-target 0.10 --max-days 30
  --signals regime --regime-min-votes 2
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend
  --regime-use-hmm --regime-use-ad-line
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50
  --config 2h-trend-v5-amber-max-passlock
  --override-tp-mult 1.10
  --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20
  --initial-window-hours 24
  --majors-list BTC,ETH,BNB,SOL
  --strict-pass
)

run_gate() {
  local label="$1"; local breadth="$2"; local majors="$3"
  local outfile="$OUT/${label}.jsonl"
  echo ""
  echo "[run] $label (breadth=$breadth majors=$majors)"

  local extra=()
  if [[ "$breadth" -gt 0 || "$majors" -gt 0 ]]; then
    extra+=(--min-initial-signal-breadth "$breadth" --min-initial-majors "$majors")
  fi

  # Capture full output to a tmp log so we can parse both summary lines.
  local tmp="$OUT/${label}.log"
  "$SWEEP" "${COMMON_ARGS[@]}" "${extra[@]}" --out "$outfile" 2>&1 | tail -8 > "$tmp"
  cat "$tmp"

  # Parse main pass line:  "...passed=A / B (X.XX%)"
  local main_line=$(grep -E "passed=[0-9]+ / [0-9]+" "$tmp" | tail -1)
  local total=$(echo "$main_line" | sed -nE 's/.*passed=[0-9]+ \/ ([0-9]+).*/\1/p')
  local uncond_pct=$(echo "$main_line" | sed -nE 's/.*passed=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/p')

  # Parse qualified-line (only present when gate is active).
  local qual_line=$(grep "qualified=" "$tmp" || true)
  local qualified=""; local cond_pct=""; local qual_share=""
  if [[ -n "$qual_line" ]]; then
    qualified=$(echo "$qual_line" | sed -nE 's/.*qualified=([0-9]+) \/ [0-9]+.*/\1/p')
    qual_share=$(echo "$qual_line" | sed -nE 's/.*qualified=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/p')
    cond_pct=$(echo "$qual_line" | sed -nE 's/.*passed_of_qualified=[0-9]+ \/ [0-9]+ \(([0-9.]+)%\).*/\1/p')
  else
    qualified="$total"  # gate disabled = all qualified
    qual_share="100.00"
    cond_pct="$uncond_pct"
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$label" "$breadth" "$majors" "${qualified:-NA}" "${total:-NA}" \
    "${cond_pct:-NA}" "${uncond_pct:-NA}" "${qual_share:-NA}" \
    | tee -a "$RESULTS"
}

START_TS=$(date +%s)

run_gate "G00_no_gate"     0  0
run_gate "G01_b4_m3_old"   4  3
run_gate "G02_b8_m2"       8  2
run_gate "G03_b10_m2_def" 10  2
run_gate "G04_b10_m3"     10  3
run_gate "G05_b12_m3"     12  3
run_gate "G06_b6_m4_TierS" 6  4

ELAPSED=$(($(date +%s) - START_TS))
echo ""
echo "=== Gate sweep step=1 complete in ${ELAPSED}s ==="
echo ""
echo "=== Sorted by conditional pct desc ==="
( head -1 "$RESULTS"; tail -n +2 "$RESULTS" | sort -t$'\t' -k6 -rn ) | column -t -s$'\t'
echo ""
echo "=== Sorted by unconditional pct desc ==="
( head -1 "$RESULTS"; tail -n +2 "$RESULTS" | sort -t$'\t' -k7 -rn ) | column -t -s$'\t'
