#!/usr/bin/env bash
# 3-Strategy Multi-Account FTMO Bot starter.
#
# Math: 1 - (1 - p1)(1 - p2)(1 - p3) min-1-pass probability.
#   - R28_V6: 56.62% → fail = 43.38%
#   - V5_TITANIUM: 58.24% → fail = 41.76%
#   - V5_AMBER: 62.83% → fail = 37.17%
#   - 3-strategy min-1-pass: 1 - 0.4338 × 0.4176 × 0.3717 = 93.27%
#
# vs single-account: 56.62% (need 30+pp boost for 90% target)
# vs 2× R28_V6: 81.18% (correlated — both fail when crypto crashes)
# vs 3× R28_V6: 91.79% (better but still correlated)
# vs 3-strategy: 93.27% (uncorrelated assets + tuning → robust)
#
# Cost: 3× FTMO Demo registration. Or 1× FTMO + 2× alternate prop firms.
#
# Prerequisites:
#   - VPS with 3 separate MT5 logins (one per account)
#   - .env.ftmo.demo1 (R28_V6, master Telegram listener)
#   - .env.ftmo.titanium (V5_TITANIUM, send-only)
#   - .env.ftmo.amber (V5_AMBER, send-only)
#   - PM2 installed
#
# Usage:
#   bash tools/start-3-strategy.sh

set -e
cd "$(dirname "$0")/.."

ROOT_DIR=$(pwd)
ENV_FILES=(
  ".env.ftmo.demo1"
  ".env.ftmo.titanium"
  ".env.ftmo.amber"
)

echo "[3-strategy] Pre-flight: verify all 3 env files exist..."
for f in "${ENV_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "[FATAL] missing $f — copy from $f.example and fill in placeholders"
    exit 1
  fi
done

echo "[3-strategy] Pre-flight: verify MT5 login mismatch detection..."
for f in "${ENV_FILES[@]}"; do
  # Use sed instead of cut: only grab content after the FIRST '=' so values
  # containing '=' are preserved. Strip optional surrounding quotes + angle
  # brackets used in templates.
  login=$(sed -n -E "s/^FTMO_EXPECTED_LOGIN=['\"]?([^'\"]*)['\"]?$/\1/p" "$f" | tr -d '<>')
  # Reject placeholder leftovers (templates use <YOUR-MT5-LOGIN-NUMBER>) AND
  # reject anything non-numeric (FTMO logins are always numeric).
  if [[ -z "$login" ]] || [[ "$login" =~ MT5 ]] || [[ ! "$login" =~ ^[0-9]+$ ]]; then
    echo "[FATAL] $f: FTMO_EXPECTED_LOGIN not set or non-numeric (still placeholder?)"
    exit 1
  fi
  echo "  $f: login=$login"
done

echo "[3-strategy] Pre-flight: verify exactly ONE master Telegram listener..."
master_count=0
for f in "${ENV_FILES[@]}"; do
  if grep -q "^FTMO_TELEGRAM_BOT_MASTER=1" "$f"; then
    master_count=$((master_count + 1))
    echo "  $f → master listener"
  fi
done
if [[ $master_count -ne 1 ]]; then
  echo "[FATAL] Expected exactly 1 master listener, got $master_count."
  echo "  Set FTMO_TELEGRAM_BOT_MASTER=1 in .env.ftmo.demo1 ONLY."
  exit 1
fi

echo "[3-strategy] Pre-flight: run preflight_check.py per account..."
for f in "${ENV_FILES[@]}"; do
  echo ""
  echo "===== preflight: $f ====="
  if ! (set -a; . "$f"; set +a; python tools/preflight_check.py); then
    echo "[FATAL] preflight failed for $f — fix issues and re-run"
    exit 1
  fi
done

echo ""
echo "[3-strategy] All pre-flight checks GO. Starting PM2..."

# Use the dedicated multi-account ecosystem config which auto-discovers
# each .env.ftmo.* file and launches signal+executor pairs per account.
pm2 start tools/ecosystem-multi.config.js
pm2 save
pm2 list

echo ""
echo "[3-strategy] All 3 accounts running (signal+executor pairs each)."
echo "  Telegram master: ftmo-signal-r28-v6 (consumes /getUpdates)"
echo "  Telegram silent: ftmo-signal-titanium, ftmo-signal-amber (send-only)"
echo ""
echo "Drift dashboards:"
echo "  /dashboard/drift?ftmo_tf=2h-trend-v5-quartz-lite-r28-v6-v4engine-demo1"
echo "  /dashboard/drift?ftmo_tf=2h-trend-v5-titanium-titanium"
echo "  /dashboard/drift?ftmo_tf=2h-trend-v5-amber-amber"
echo ""
echo "Monitor: pm2 logs --lines 50"
echo "Kill all: pm2 stop ftmo-r28-v6 ftmo-titanium ftmo-amber"
