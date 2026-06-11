#!/bin/bash
# 2026-05-20 Kill-Switch robustness grid: H × N × X = 3×3×3 = 27 cells.
# Runs serially (2 threads each) to keep load manageable. Results appended
# to scripts/cache_bakeoff/kill_switch_test/results.tsv with header:
#   H<TAB>N<TAB>X<TAB>pass_count<TAB>total<TAB>pass_pct
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=scripts/cache_bakeoff/kill_switch_test/results.tsv
mkdir -p "$(dirname "$OUT")"
[[ -f "$OUT" ]] || printf "H\tN\tX\tpass_count\ttotal\tpass_pct\n" > "$OUT"

SWEEP=./engine-rust/target/release/ftmo-sweep
COMMON=(
  --candles-dir scripts/cache_bakeoff
  --funding-dir scripts/cache_bakeoff
  --symbols AAVEUSDT,ADAUSDT,ALGOUSDT,ARBUSDT,ATOMUSDT,AVAXUSDT,BCHUSDT,BNBUSDT,BTCUSDT,DOTUSDT,ETCUSDT,ETHUSDT,LINKUSDT,LTCUSDT,NEARUSDT,SOLUSDT,UNIUSDT,XRPUSDT
  --windows 9999 --step-days 1 --threads 2
  --profit-target 0.10 --max-days 30
  --signals regime --regime-min-votes 2
  --regime-poc-z --regime-bb-z-mr --regime-use-supertrend --regime-use-hmm --regime-use-ad-line
  --cross-asset-sym BNBUSDT --cross-asset-fast 18 --cross-asset-slow 50
  --config 2h-trend-v5-amber-max-passlock --override-tp-mult 1.10
  --kelly-sizing --kelly-fraction 0.5 --kelly-window 60 --kelly-min-trades 20
  --strict-pass
)

for H in 18 24 30; do
  for N in 4 6 8; do
    for X in -0.015 -0.02 -0.03; do
      key="H${H}_N${N}_X${X}"
      log="scripts/cache_bakeoff/kill_switch_test/${key}.log"
      err="scripts/cache_bakeoff/kill_switch_test/${key}.err"
      echo "=== running $key ==="
      "$SWEEP" "${COMMON[@]}" \
        --kill-switch-hour $H \
        --kill-switch-min-trades $N \
        --kill-switch-min-equity $X \
        > "$log" 2> "$err" || { echo "FAILED $key"; tail -5 "$err"; continue; }
      # Final summary line: "passed=NNN / TOTAL (PCT%)"
      line=$(grep -E "^passed=" "$log" | tail -1)
      if [[ -z "$line" ]]; then
        echo "NO_PASS_LINE $key"; continue
      fi
      pc=$(echo "$line" | sed -E 's/passed=([0-9]+) \/ ([0-9]+) .*/\1/')
      tot=$(echo "$line" | sed -E 's/passed=([0-9]+) \/ ([0-9]+) .*/\2/')
      pct=$(echo "$line" | sed -E 's/.*\(([0-9.]+)%\).*/\1/')
      printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$H" "$N" "$X" "$pc" "$tot" "$pct" >> "$OUT"
      echo "  $key => $line"
    done
  done
done
echo "=== robustness grid done ==="
sort -t$'\t' -k6 -n -r "$OUT" | head -10
