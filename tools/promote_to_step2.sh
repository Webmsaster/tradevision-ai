#!/usr/bin/env bash
# Promote a passed Step-1 FTMO challenge to Step-2.
#
# Usage:
#   bash tools/promote_to_step2.sh [.env-file]
#
# Default env-file: .env.ftmo (single-account) or specify .env.ftmo.demo1 etc.
#
# What it does:
#   1. Verify Step-1 was passed (read state file's `passed` flag)
#   2. Stop the bot (pm2 stop)
#   3. Archive state-dir to <state-dir>.step1.archive.<timestamp>
#   4. Update .env-file: FTMO_TF=<step1>-step2 (e.g. r28-v6-passlock-step2)
#   5. Restart bot — fresh state, Step-2 rules (5% target, 60d, holdBars 1200)
#
# Safety:
#   - Requires manual confirmation before stop/restart
#   - Archives state, never deletes
#   - Telegram alert when Step-2 starts

set -e
cd "$(dirname "$0")/.."

ENV_FILE="${1:-.env.ftmo}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[promote] FATAL: $ENV_FILE not found"
  exit 1
fi

# Source env file in a SUBSHELL to extract only the 2 vars we need.
# Avoids leaking TELEGRAM_BOT_TOKEN_* / NEWS_API_KEY into this shell's
# environment (which would propagate to pm2/python3 child processes and
# could surface in `ps`/log dumps).
read -r FTMO_TF FTMO_ACCOUNT_ID < <(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  printf '%s %s\n' "${FTMO_TF:-}" "${FTMO_ACCOUNT_ID:-default}"
)

if [[ -z "$FTMO_TF" ]]; then
  echo "[promote] FATAL: FTMO_TF not set in $ENV_FILE"
  exit 1
fi

ACCOUNT_ID="${FTMO_ACCOUNT_ID:-default}"

# Sanity-check: FTMO_TF / ACCOUNT_ID must be safe path-component (no slash,
# no shell metachar). Used to build STATE_DIR + Python heredoc + sed pattern.
if [[ ! "$FTMO_TF" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[promote] FATAL: FTMO_TF contains unsafe chars: $FTMO_TF"
  exit 1
fi
if [[ ! "$ACCOUNT_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[promote] FATAL: FTMO_ACCOUNT_ID contains unsafe chars: $ACCOUNT_ID"
  exit 1
fi

STATE_DIR="ftmo-state-${FTMO_TF}-${ACCOUNT_ID}"

if [[ ! -d "$STATE_DIR" ]]; then
  echo "[promote] FATAL: $STATE_DIR not found — bot never ran?"
  exit 1
fi

# Check pass status — pass STATE_DIR via env-var (NOT shell interpolation
# into the Python heredoc) so quoting/injection cannot break the script
# even if STATE_DIR ever contains odd chars.
PASSED=$(STATE_DIR="$STATE_DIR" python3 -c "
import json, os, sys
sd = os.environ['STATE_DIR']
try:
    with open(os.path.join(sd, 'pause-state.json')) as f:
        data = json.load(f)
    print('yes' if data.get('passed') else 'no')
except Exception as e:
    print(f'error: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null) || {
  echo "[promote] FATAL: cannot read pause-state.json"
  exit 1
}

if [[ "$PASSED" != "yes" ]]; then
  echo "[promote] FATAL: Step-1 not passed yet (pause-state.json: passed=$PASSED)"
  exit 1
fi

# Determine step-2 selector. Map known champions to their step2 variants.
STEP2_TF=""
case "$FTMO_TF" in
  *r28-v6-passlock*)
    STEP2_TF="2h-trend-v5-quartz-lite-r28-step2"
    echo "[promote] Mapped passlock → r28-step2 (77.86% backtest)"
    ;;
  *r28-v6*|*r28-v5*)
    STEP2_TF="2h-trend-v5-quartz-lite-r28-step2"
    echo "[promote] Mapped r28 family → r28-step2"
    ;;
  *titanium*|*amber*)
    STEP2_TF="2h-trend-v5-quartz-step2"
    echo "[promote] Mapped V5 family → quartz-step2"
    ;;
  *)
    echo "[promote] FATAL: unknown FTMO_TF=$FTMO_TF — no step2 mapping"
    echo "  Edit this script to add mapping, or set step2-TF manually."
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  STEP-1 → STEP-2 PROMOTION"
echo "═══════════════════════════════════════════════════════"
echo "  Account:       $ACCOUNT_ID"
echo "  Current TF:    $FTMO_TF"
echo "  New TF:        $STEP2_TF"
echo "  State-dir:     $STATE_DIR"
echo "  Will archive:  ${STATE_DIR}.step1.archive.<timestamp>"
echo "═══════════════════════════════════════════════════════"
echo ""
read -rp "Proceed? (yes/NO): " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "[promote] aborted"
  exit 0
fi

# Stop matching pm2 processes for this account.
PM2_PATTERN="ftmo-(signal|executor)-${ACCOUNT_ID}"
echo "[promote] Stopping pm2 processes matching: $PM2_PATTERN"
pm2 list | grep -E "$PM2_PATTERN" | awk '{print $4}' | while read -r name; do
  if [[ -n "$name" && "$name" != "name" ]]; then
    echo "  pm2 stop $name"
    pm2 stop "$name" || true
  fi
done

# Archive state-dir. Use mv -n to refuse overwriting on timestamp collision
# (e.g. retried promotion within the same second).
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE_DIR="${STATE_DIR}.step1.archive.${TIMESTAMP}"
if [[ -e "$ARCHIVE_DIR" ]]; then
  echo "[promote] FATAL: archive target already exists: $ARCHIVE_DIR"
  exit 1
fi
echo "[promote] Archiving $STATE_DIR → $ARCHIVE_DIR"
mv -n "$STATE_DIR" "$ARCHIVE_DIR"
# Tighten permissions on archived state — may contain trade history,
# state-files referencing account IDs. 0700 = owner-only.
chmod -R go-rwx "$ARCHIVE_DIR" 2>/dev/null || true

# Update env file in-place (FTMO_TF line)
echo "[promote] Updating $ENV_FILE: FTMO_TF=$STEP2_TF"
sed -i.bak -E "s|^FTMO_TF=.*|FTMO_TF=$STEP2_TF|" "$ENV_FILE"
echo "  (backup at ${ENV_FILE}.bak)"

# Restart pm2 processes via ecosystem-multi.config.js
echo "[promote] Restarting via ecosystem-multi.config.js"
pm2 start tools/ecosystem-multi.config.js --update-env

pm2 save
pm2 list

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ STEP-2 STARTED"
echo "═══════════════════════════════════════════════════════"
echo "  Account:    $ACCOUNT_ID"
echo "  Strategy:   $STEP2_TF"
echo "  Target:     +5% in 60 days (5% DL, 10% TL, minDays 4)"
echo "  Backtest:   77.86% pass-rate (R28_STEP2 honest, V4-Sim)"
echo "  Joint Step-1+Step-2 with PASSLOCK: 64.77% × 77.86% ≈ 50% Funded"
echo "  3-Strategy: ~94% × 78% ≈ 73% Funded"
echo "═══════════════════════════════════════════════════════"
