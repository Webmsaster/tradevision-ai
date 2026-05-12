#!/bin/bash
# R29 Hunt Phase 3: walk-forward train/test split on a config.
# Usage: _huntPhase3.sh <config>
# Splits candle range into 4 quartiles; reports pass-rate per quartile.
# A robust config has narrow quartile spread (≤10pp). Wide drift = overfit.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x ./engine-rust/target/release/ftmo-sweep ] || { echo "ERROR: ftmo-sweep binary missing" >&2; exit 3; }

SYMS_BASE="ETHUSDT,BTCUSDT,BNBUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LTCUSDT,BCHUSDT,AAVEUSDT,XRPUSDT,INJUSDT,RUNEUSDT,ETCUSDT,SANDUSDT"
SYMS_R28V6="BTCUSDT,ETHUSDT,BNBUSDT,ADAUSDT,LTCUSDT,BCHUSDT,ETCUSDT,XRPUSDT,AAVEUSDT"
SWEEP=./engine-rust/target/release/ftmo-sweep
LOG="/tmp/hunt_phase3_$$.log"
LOG_FINAL=/tmp/hunt_phase3.log
: > "$LOG"
trap 'rm -f "$LOG.partial"' EXIT INT TERM

cfg="${1:-}"
[ -z "$cfg" ] && { echo "usage: $0 <config>"; exit 1; }
# Validate config name to avoid shell-injection via embedded special chars
[[ "$cfg" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "ERROR: bad config name: $cfg" >&2; exit 1; }

# Portable epoch-seconds → ISO-date helper (GNU date `-d @ts` is Linux-only).
iso_date_from_epoch() {
  local epoch_s="$1"
  local fmt="${2:-%Y-%m-%d}"
  if date -u -d "@$epoch_s" "+$fmt" >/dev/null 2>&1; then
    date -u -d "@$epoch_s" "+$fmt"
  else
    python3 -c "import datetime,sys; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).strftime(sys.argv[2]))" "$epoch_s" "$fmt"
  fi
}

# Resolve python3 portably (Mac /opt/homebrew, Linux /usr/bin/python3)
PY3="$(command -v python3 || true)"
[ -z "$PY3" ] && { echo "ERROR: python3 not found in PATH" >&2; exit 4; }
[ -f scripts/cache_bakeoff/BTCUSDT_30m.json ] || { echo "ERROR: scripts/cache_bakeoff/BTCUSDT_30m.json missing — Phase 3 needs reference candles" >&2; exit 5; }

syms="$SYMS_BASE"
case "$cfg" in
  *r28-v6*) syms="$SYMS_R28V6" ;;
esac

# Compute total candle count from BTC reference (30m default)
total=$("$PY3" -c "import json; print(len(json.load(open('scripts/cache_bakeoff/BTCUSDT_30m.json'))))")
echo "Total bars: $total" | tee -a "$LOG"

# 30m bar = 30min × 1000 × 60 / 1000 = 1.8M ms — 1 bar = 0.5h
# 4 quartiles. Use --start-after-ts and --windows to slice.
ms_per_bar=1800000
btc_first=$("$PY3" -c "import json; print(json.load(open('scripts/cache_bakeoff/BTCUSDT_30m.json'))[0]['openTime'])")
btc_last=$("$PY3" -c "import json; print(json.load(open('scripts/cache_bakeoff/BTCUSDT_30m.json'))[-1]['openTime'])")
span=$(( btc_last - btc_first ))
qs=$(( span / 4 ))
echo "Range: $btc_first to $btc_last (span=$span ms, qs=$qs)" | tee -a "$LOG"

for q in 0 1 2 3; do
  start=$(( btc_first + q * qs ))
  end=$(( start + qs ))
  # Convert to ISO for log (portable)
  iso=$(iso_date_from_epoch "$(( start / 1000 ))" %Y-%m-%d 2>/dev/null || echo "$start")
  echo "=== $cfg Q$((q+1)) @ start=$iso ===" | tee -a "$LOG"
  if ! $SWEEP \
    --candles-dir scripts/cache_bakeoff --symbols "$syms" \
    --config "$cfg" \
    --windows 100 --step-days 14 --signals per-asset \
    --start-after-ts "$start" \
    --phantom-suppress 2>&1 | tail -1 | tee -a "$LOG"; then
    echo "[warn] quartile Q$((q+1)) failed — continuing" | tee -a "$LOG"
  fi
done
echo "" | tee -a "$LOG"
echo "=== SUMMARY ($cfg) ===" | tee -a "$LOG"
grep -E "===|passed=" "$LOG" | tee -a "$LOG"

cp -f "$LOG" "$LOG_FINAL"
