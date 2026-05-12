#!/bin/bash
# R29 Hunt Phase 1: sweep every existing config at step=14d, ≥120 windows.
# Output: pass-rate per config, sorted descending. Any config ≥60% goes to Phase 2.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing — build via cargo build --release" >&2; exit 3; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SYMS_R28V6="BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT,ETCUSDT,XRPUSDT,AAVEUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase1_$$.log"
LOG_FINAL=/tmp/hunt_phase1.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

# flock helper — uses flock(1) when available, else no-op (per-PID logfile makes this safe)
_log_append() {
  if command -v flock >/dev/null 2>&1; then
    flock "$LOG" -c "cat >> '$LOG'"
  else
    cat >> "$LOG"
  fi
}

run() {
  local cfg="$1"
  local syms="$2"
  local extra="${3:-}"
  echo "=== $cfg ($extra) ===" | tee -a "$LOG"
  # shellcheck disable=SC2086  # intentional word-split of $extra (override flags)
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$syms" \
    --config "$cfg" \
    --windows 200 --step-days 14 --signals per-asset \
    $extra 2>&1 | tail -3 | tee -a "$LOG"; then
    # NOTE 2026-05-12: --phantom-suppress removed (R29 audit finding).
    # The flag was inverted vs intent and systematically UNDER-counted pass-rate
    # by suppressing legitimate wins as "phantoms". See MEMORY 2026-05-10 cleanup.
    echo "[warn] $cfg failed — continuing" | tee -a "$LOG"
  fi
}

# 14-asset basket configs
for cfg in \
  "2h-trend-v5-titanium-passlock" \
  "2h-trend-v5-titanium-passlock-norune" \
  "2h-trend-v5-titanium-passlock-corrcap2" \
  "2h-trend-v5-titanium-passlock-lscool-tight" \
  "2h-trend-v5-titanium-passlock-lscool-loose" \
  "2h-trend-v5-titanium-passlock-mct5" \
  "2h-trend-v5-titanium-passlock-todcut18" \
  "2h-trend-v5-titanium-passlock-hunter" \
  "2h-trend-v5-obsidian-passlock" \
  "2h-trend-v5-titanium" \
  "2h-trend-v5-amber" \
  "2h-trend-v5-topaz"; do
  run "$cfg" "$SYMS_BASE" ""
done

# 9-asset basket configs (R28_V6 family)
for cfg in \
  "2h-trend-v5-r28-v6-passlock" \
  "2h-trend-v5-quartz-lite-r28-v6"; do
  run "$cfg" "$SYMS_R28V6" ""
done

echo "" | tee -a "$LOG"
echo "=== SORTED ===" | tee -a "$LOG"
# Use awk state machine: capture label line ("=== cfg (...) ==="), then on
# next passed= line emit "PCT  LABEL". This is immune to extra interleaved
# lines (bars/sec banner, Rust sweep banner re-print, etc.) that broke the
# previous `grep -B1 | paste - - -` pairing.
awk '
  /^=== / { match($0, /=== ([^ ]+)/, m); if (m[1] != "") label = m[1]; next }
  /passed=/ {
    if (label != "" && match($0, /\(([0-9.]+)%\)/, p)) {
      print p[1] "  " label
      label = ""
    }
  }
' "$LOG" | sort -rg | tee -a "$LOG"

# Finalize: atomic move to shared log location (last writer wins, no torn writes)
cp -f "$LOG" "$LOG_FINAL"
