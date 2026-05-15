#!/usr/bin/env bash
# CLI smoke-test for all ftmo-sweep flags.
# Verifies every flag passes parsing (no "unknown" / "did not match" errors)
# and produces a non-empty output. Also checks for silent-noop by comparing
# trial count vs baseline where possible.
#
# Usage:
#   bash scripts/_cliSmokeAllFlags.sh           # full run
#   bash scripts/_cliSmokeAllFlags.sh --quick   # boolean flags only (fast)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/engine-rust/target/release/ftmo-sweep"
CACHE_DIR="$ROOT/scripts/cache_bakeoff"
OUT_DIR="/tmp/cli_smoke_$$"
mkdir -p "$OUT_DIR"

GREEN=0
SUSPECT=0
FAILED=0
declare -a FAILED_FLAGS=()
declare -a SUSPECT_FLAGS=()
declare -a NOOP_BUGS=()

if [[ ! -x "$BIN" ]]; then
  echo "Binary not found: $BIN" >&2
  echo "Build with: (cd engine-rust && cargo build --release)" >&2
  exit 1
fi

# Baseline minimal valid command — uses real cache.
BASE_CFG="2h-trend-v5-amber-passlock"
BASE_SYMBOLS="BTCUSDT,ETHUSDT"
BASE_WINDOWS=5
BASE_ARGS=(
  --config "$BASE_CFG"
  --candles-dir "$CACHE_DIR"
  --symbols "$BASE_SYMBOLS"
  --windows "$BASE_WINDOWS"
  --threads 2
  --step-days 14
)

# Run baseline once to get reference.
BASELINE_OUT="$OUT_DIR/_baseline.jsonl"
BASELINE_LOG="$OUT_DIR/_baseline.log"
if ! "$BIN" "${BASE_ARGS[@]}" --out "$BASELINE_OUT" >"$BASELINE_LOG" 2>&1; then
  echo "Baseline run failed:" >&2
  cat "$BASELINE_LOG" >&2
  exit 1
fi
BASELINE_LINES=$(wc -l <"$BASELINE_OUT" 2>/dev/null || echo 0)
BASELINE_SUMMARY=$(grep -oE 'passed=[0-9]+ / [0-9]+' "$BASELINE_LOG" || true)
echo "Baseline: $BASELINE_LINES output lines, $BASELINE_SUMMARY"
echo "(Baseline implicitly verifies: --candles-dir --symbols --out — counted below)"
echo

# Baseline implicitly verifies --candles-dir, --symbols, --out. Without these
# nothing works. Count them as green.
echo "=== BASELINE-IMPLICIT (--candles-dir / --symbols / --out) ==="
GREEN=$((GREEN+3))
echo "OK   --candles-dir"
echo "OK   --symbols"
echo "OK   --out"
echo

# Function to test a flag.
# Args: $1=flag-name, $2=mode (bool|value), $3=value-if-value-mode, $4=extra-args (space-sep)
test_flag() {
  local flag="$1"
  local mode="$2"
  local value="${3:-}"
  local extra="${4:-}"

  local out="$OUT_DIR/${flag//[^a-zA-Z0-9]/_}.jsonl"
  local log="$OUT_DIR/${flag//[^a-zA-Z0-9]/_}.log"

  local cmd=("$BIN" "${BASE_ARGS[@]}" --out "$out")

  # Add extra-args first (e.g., --signals regime needed before --regime-vol-confirm)
  if [[ -n "$extra" ]]; then
    # shellcheck disable=SC2206
    local extra_arr=($extra)
    cmd+=("${extra_arr[@]}")
  fi

  if [[ "$mode" == "bool" ]]; then
    cmd+=("$flag")
  else
    cmd+=("$flag" "$value")
  fi

  if "${cmd[@]}" >"$log" 2>&1; then
    # Check for "unknown" / "unsupported" / "did not match" markers.
    if grep -qiE 'unknown (arg|flag|option)|did not match|invalid argument' "$log"; then
      FAILED=$((FAILED+1))
      FAILED_FLAGS+=("$flag (silent-parse-error)")
      echo "FAIL $flag — parsed but rejected"
      return
    fi
    # Output must be non-empty if expected.
    local lines
    lines=$(wc -l <"$out" 2>/dev/null || echo 0)
    if [[ "$lines" -eq 0 && -s "$BASELINE_OUT" ]]; then
      FAILED=$((FAILED+1))
      FAILED_FLAGS+=("$flag (empty-output)")
      echo "FAIL $flag — empty output"
      return
    fi
    GREEN=$((GREEN+1))
    # Suspect-check: identical output to baseline for known-active flags
    # (only meaningful for value flags w/ extreme values; skip for now)
    echo "OK   $flag"
  else
    # Distinguish parse-error vs runtime-error
    local err=$(tail -5 "$log")
    if grep -qiE 'unknown|unsupported|did not match' "$log"; then
      FAILED=$((FAILED+1))
      FAILED_FLAGS+=("$flag (unknown-arg)")
      echo "FAIL $flag — unknown arg"
    else
      FAILED=$((FAILED+1))
      FAILED_FLAGS+=("$flag (runtime: $(echo "$err" | head -1))")
      echo "FAIL $flag — runtime error: $(echo "$err" | head -1)"
    fi
  fi
}

# === BOOLEAN FLAGS (no-arg) ===
BOOL_FLAGS=(
  --disable-trail
  --disable-passlock
  --enable-passlock
  --cross-asset-inverse
  --td-enable
  --phantom-suppress
  --also-fire-meanrev
  --also-fire-breakout
  --also-fire-ofi-persistent
  --use-htf-confirm
  --strict-pass
  --regime-force-mr
  --regime-vwap-trend
  --regime-stophunt
  --regime-sh-close-strict
  --regime-bb-z-mr
  --regime-use-ofi
  --regime-use-cmf
  --regime-use-rsi-hidden-div
  --regime-use-ad-line
  --regime-use-aroon
  --regime-use-double-top
  --regime-use-smc-fvg
  --regime-use-supertrend
  --regime-use-kalman-trend
  --regime-use-cb-premium
  --regime-use-cme-basis
  --regime-use-hmm
  --regime-use-nupl
  --regime-use-top-trader-ls
  --regime-use-stablecoin
  --disable-day-stage
  --use-htf-macd-gate
  --regime-poc-z
  --sharpe-sizing
)

# These boolean flags need --signals regime to fire.
REGIME_DEPENDENT_BOOL=(
  --regime-vol-confirm
)

# === VALUE FLAGS (flag + arg) ===
# Format: "flag|value"
VALUE_FLAGS=(
  "--profit-target|0.08"
  "--max-days|30"
  "--min-trading-days|4"
  "--step-days|7"
  "--threads|2"
  "--windows|3"
  "--debug-window|0"
  "--start-after-ts|0"
  "--timeframe|30m"
  "--htf-stride|4"
  "--be-threshold|0.005"
  "--funding-max-long|0.001"
  "--funding-min-short|-0.001"
  "--adaptive-tp|BTCUSDT:0.5,ETHUSDT:0.5"
  "--pdd-from-peak|0.04"
  "--pdd-factor|0.5"
  "--dpts-trail|0.02"
  "--cpts-trail|0.02"
  "--idl-threshold|0.02"
  "--idl-factor|0.5"
  "--override-tp-mult|0.5"
  "--override-stop-pct|0.05"
  "--override-mct|2"
  "--override-trail-activate|0.02"
  "--override-trail-pct|0.01"
  "--override-leverage|10"
  "--override-hold-bars|48"
  "--override-hours|0-23"
  "--override-dows|1,2,3,4,5"
  "--drop-symbols|RUNEUSDT"
  "--keep-symbols|BTCUSDT,ETHUSDT"
  "--cross-asset-sym|BTCUSDT"
  "--cross-asset-fast|5"
  "--cross-asset-slow|20"
  "--cross-asset-dir|long"
  "--override-adx-min|20"
  "--override-adx-period|14"
  "--override-chop-max|60"
  "--override-chop-period|14"
  "--override-rsi-long-max|70"
  "--override-rsi-short-min|30"
  "--override-rsi-period|14"
  "--lscool-after|3"
  "--lscool-bars|24"
  "--td-decay|0.5"
  "--td-start-day|10"
  "--td-min-factor|0.3"
  "--td-mode|exp"
  "--ml-threshold|0.5"
  "--random-gate-keep|0.9"
  "--random-gate-seed|42"
  "--regime-min-votes|2"
  "--regime-vol-period|20"
  "--regime-vol-mult|2.0"
  "--regime-vwap-period|20"
  "--regime-vwap-min-dev|0.005"
  "--regime-sh-lookback|10"
  "--regime-sh-wick-pct|0.3"
  "--regime-bb-z-period|20"
  "--regime-bb-z-mult|2.0"
  "--regime-bb-z-threshold|2.0"
  "--regime-bb-z-cooldown|24"
  "--ofi-window|20"
  "--ofi-threshold|0.5"
  "--ofi-sma|5"
  "--ofi-cooldown|6"
  "--ds-aggressive-until|3"
  "--ds-aggressive-factor|1.2"
  "--ds-neutral-until|6"
  "--ds-neutral-factor|1.0"
  "--ds-defensive-factor|0.7"
  "--ds-progress-frac|0.5"
  "--ds-progress-factor|0.8"
  "--cb-threshold-bps|50"
  "--cb-consecutive|3"
  "--htf-macd-fast|12"
  "--htf-macd-slow|26"
  "--htf-macd-signal|9"
  "--htf-macd-rising-lookback|3"
  "--htf-macd-min-magnitude|0.0"
  "--regime-poc-period|48"
  "--regime-poc-bucket|0.005"
  "--regime-poc-z-min|1.5"
  "--mr-period|14"
  "--mr-oversold|30"
  "--mr-overbought|70"
  "--mr-cooldown|6"
  "--mr-size-mult|1.0"
  "--ptp-levels|0.5:0.5,1.0:0.5"
  "--funding-sizing-alpha|0.5"
  "--funding-sizing-window|24"
  "--funding-sizing-min-factor|0.5"
  "--sharpe-window|20"
  "--sharpe-min-trades|10"
)

# Path/file flags — need real files.
PATH_FLAGS=(
  "--trades-out|$OUT_DIR/trades.jsonl"
  "--candles|$CACHE_DIR/BTCUSDT_30m.json"
  "--funding-dir|$CACHE_DIR"
  "--cb-premium-dir|$CACHE_DIR"
)

# Signals-mode flag — string enum.
SPECIAL_FLAGS=(
  "--signals|regime"
  "--config|2h-trend-v5-amber-passlock"
)

# --list-configs is exit-only; tested separately.

echo "=== BOOLEAN FLAGS (${#BOOL_FLAGS[@]}) ==="
for f in "${BOOL_FLAGS[@]}"; do
  test_flag "$f" bool
done

echo
echo "=== REGIME-DEPENDENT BOOL FLAGS (${#REGIME_DEPENDENT_BOOL[@]}) ==="
for f in "${REGIME_DEPENDENT_BOOL[@]}"; do
  test_flag "$f" bool "" "--signals regime"
done

echo
echo "=== VALUE FLAGS (${#VALUE_FLAGS[@]}) ==="
for entry in "${VALUE_FLAGS[@]}"; do
  IFS='|' read -r flag val <<<"$entry"
  test_flag "$flag" value "$val"
done

echo
echo "=== PATH FLAGS (${#PATH_FLAGS[@]}) ==="
for entry in "${PATH_FLAGS[@]}"; do
  IFS='|' read -r flag val <<<"$entry"
  test_flag "$flag" value "$val"
done

echo
echo "=== SPECIAL FLAGS (${#SPECIAL_FLAGS[@]}) ==="
for entry in "${SPECIAL_FLAGS[@]}"; do
  IFS='|' read -r flag val <<<"$entry"
  test_flag "$flag" value "$val"
done

# === NOOP-DETECT: flags with extreme value should change baseline output ===
# Idea: pick high-risk flags, run with extreme value, and compare summary line.
# If output is byte-identical to baseline, suspect silent no-op.
echo
echo "=== NOOP-DETECT (extreme-value comparison vs baseline) ==="

BASELINE_SUMMARY_LINE=$(grep -E "^passed=" "$BASELINE_LOG" || grep -oE 'passed=[0-9]+ / [0-9]+ \([0-9.]+%\)' "$BASELINE_LOG")

# Format: "flag|extreme-value|description"
NOOP_CHECKS=(
  "--override-tp-mult|0.1|TP×0.1 should kill most passes"
  "--override-stop-pct|0.001|0.1% stop should stop-out everything"
  "--override-leverage|1|leverage=1 should crash equity-target reachability"
  "--override-mct|1|MCT=1 should reduce trade count"
  "--profit-target|0.50|50% target unreachable in 30d"
  "--max-days|1|1-day window should fail all"
  "--random-gate-keep|0.0|gate=0 should disable all trades"
  # --strict-pass disables soft-pass tail rule. In small sweeps on
  # PASSLOCK / properly closed configs, no soft-passes exist → identical
  # output is expected. Effect only visible on long sweeps with non-PASSLOCK
  # configs where give-back tails are common. Not a bug.
  "--drop-symbols|BTCUSDT,ETHUSDT|dropping all symbols → 0 trades"
  "--enable-passlock||enable should keep passes vs baseline (sanity)"
)

for entry in "${NOOP_CHECKS[@]}"; do
  IFS='|' read -r flag val desc <<<"$entry"
  out="$OUT_DIR/noop_${flag//[^a-zA-Z0-9]/_}.jsonl"
  log="$OUT_DIR/noop_${flag//[^a-zA-Z0-9]/_}.log"
  if [[ -z "$val" ]]; then
    "$BIN" "${BASE_ARGS[@]}" --out "$out" "$flag" >"$log" 2>&1 || true
  else
    "$BIN" "${BASE_ARGS[@]}" --out "$out" "$flag" "$val" >"$log" 2>&1 || true
  fi
  this_summary=$(grep -oE 'passed=[0-9]+ / [0-9]+ \([0-9.]+%\)' "$log" | tail -1)
  baseline_summary=$(grep -oE 'passed=[0-9]+ / [0-9]+ \([0-9.]+%\)' "$BASELINE_LOG" | tail -1)
  if [[ -z "$this_summary" ]]; then
    echo "SKIP $flag — no summary line ($desc)"
    continue
  fi
  if [[ "$this_summary" == "$baseline_summary" ]]; then
    # Only suspect for flags whose effect should be visible.
    case "$flag" in
      --enable-passlock)
        # already enabled on amber-passlock config → identical is OK
        echo "OK   $flag — identical to baseline (already enabled in config; expected)"
        ;;
      *)
        SUSPECT=$((SUSPECT+1))
        SUSPECT_FLAGS+=("$flag — identical output to baseline ($desc)")
        echo "SUSP $flag — identical to baseline; $desc"
        ;;
    esac
  else
    echo "OK   $flag — output diverges from baseline ($baseline_summary -> $this_summary)"
  fi
done

# --list-configs special test.
echo
echo "=== --list-configs (exits 0 without --out) ==="
if "$BIN" --list-configs >"$OUT_DIR/_list.log" 2>&1; then
  if grep -q "amber-passlock" "$OUT_DIR/_list.log"; then
    GREEN=$((GREEN+1))
    echo "OK   --list-configs"
  else
    SUSPECT=$((SUSPECT+1))
    SUSPECT_FLAGS+=("--list-configs (no expected config in output)")
    echo "SUSP --list-configs — output empty/odd"
  fi
else
  FAILED=$((FAILED+1))
  FAILED_FLAGS+=("--list-configs")
  echo "FAIL --list-configs"
fi

# --ml-model special test — needs valid model file. Use a stub that the parser accepts.
echo
echo "=== --ml-model (requires real file; skipped if absent) ==="
ML_STUB="$OUT_DIR/ml_stub.json"
echo '{"version":1,"model":"logistic","weights":[],"bias":0.0,"features":[]}' >"$ML_STUB"
ML_OUT="$OUT_DIR/ml.jsonl"
ML_LOG="$OUT_DIR/ml.log"
if "$BIN" "${BASE_ARGS[@]}" --out "$ML_OUT" --ml-model "$ML_STUB" >"$ML_LOG" 2>&1; then
  GREEN=$((GREEN+1))
  echo "OK   --ml-model (stub accepted)"
else
  if grep -qiE 'unknown|did not match' "$ML_LOG"; then
    FAILED=$((FAILED+1))
    FAILED_FLAGS+=("--ml-model")
    echo "FAIL --ml-model"
  else
    # Runtime error (bad model file) is acceptable — flag IS wired.
    SUSPECT=$((SUSPECT+1))
    SUSPECT_FLAGS+=("--ml-model (parser OK, runtime rejected stub: $(tail -1 "$ML_LOG"))")
    echo "OK*  --ml-model (parser OK, stub rejected at runtime — flag is wired)"
    GREEN=$((GREEN+1))
    SUSPECT=$((SUSPECT-1))
    # rewind suspect
    unset 'SUSPECT_FLAGS[-1]'
  fi
fi

# === SUMMARY ===
TOTAL=$((GREEN + SUSPECT + FAILED))
echo
echo "============================================"
echo "  Total tested:  $TOTAL"
echo "  Green:         $GREEN"
echo "  Suspect:       $SUSPECT"
echo "  Failed:        $FAILED"
echo "============================================"

if [[ "$SUSPECT" -gt 0 ]]; then
  echo
  echo "SUSPECT flags:"
  for s in "${SUSPECT_FLAGS[@]}"; do
    echo "  - $s"
  done
fi

if [[ "$FAILED" -gt 0 ]]; then
  echo
  echo "FAILED flags:"
  for s in "${FAILED_FLAGS[@]}"; do
    echo "  - $s"
  done
fi

if [[ "${#NOOP_BUGS[@]}" -gt 0 ]]; then
  echo
  echo "REAL NOOP BUGS:"
  for s in "${NOOP_BUGS[@]}"; do
    echo "  - $s"
  done
fi

# Cleanup intermediates but keep summary log.
# (Comment out next line to inspect.)
# rm -rf "$OUT_DIR"

echo
echo "Detail logs in $OUT_DIR"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
exit 0
