#!/usr/bin/env bash
# paperTradeCronWrapper.sh — tick + desktop-notify + webhook
#
# Runs `npm run paper:tick` and surfaces OPEN/CLOSE events via:
#   1. notify-send (Linux desktop notification)
#   2. Discord webhook (if DISCORD_WEBHOOK_URL set in env)
#   3. Slack webhook (if SLACK_WEBHOOK_URL set)
#
# Install via cron (every 15 min):
#   crontab -e
#   then add (replace PATH):
#   SHELL=/bin/bash
#   0,15,30,45 * * * * cd /PATH/to/tradevision-ai && bash scripts/paperTradeCronWrapper.sh >> ~/paper-trade.log 2>&1
#
# Or run manually:
#   DISCORD_WEBHOOK_URL=https://... bash scripts/paperTradeCronWrapper.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Run the tick and capture output
OUTPUT=$(npm run paper:tick 2>&1 || true)

# 2. Echo to stdout (cron log)
echo "$OUTPUT"

# 3. Parse OPEN / CLOSE events
OPENS=$(echo "$OUTPUT" | grep -E "^\s+OPEN " || true)
CLOSES=$(echo "$OUTPUT" | grep -E "^\s+CLOSE " || true)
SKIPS=$(echo "$OUTPUT" | grep -E "^\s+SKIP " || true)

if [[ -z "$OPENS" && -z "$CLOSES" ]]; then
  # Nothing happened this tick; silent success (cron-friendly)
  exit 0
fi

# 4. Desktop notification (if notify-send available + DISPLAY set)
if command -v notify-send >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
  if [[ -n "$OPENS" ]]; then
    count=$(echo "$OPENS" | wc -l)
    notify-send "📈 TradeVision — ${count} new signal(s)" "$OPENS" --urgency=normal --icon=dialog-information || true
  fi
  if [[ -n "$CLOSES" ]]; then
    count=$(echo "$CLOSES" | wc -l)
    notify-send "📊 TradeVision — ${count} position(s) closed" "$CLOSES" --urgency=low --icon=dialog-information || true
  fi
fi

# 5. Discord webhook
if [[ -n "${DISCORD_WEBHOOK_URL:-}" ]]; then
  PAYLOAD=""
  if [[ -n "$OPENS" ]]; then
    PAYLOAD+="**📈 New signals**\n\`\`\`\n${OPENS}\n\`\`\`\n"
  fi
  if [[ -n "$CLOSES" ]]; then
    PAYLOAD+="**📊 Closed**\n\`\`\`\n${CLOSES}\n\`\`\`\n"
  fi
  if [[ -n "$SKIPS" ]]; then
    PAYLOAD+="_Risk-gate skipped:_\n\`\`\`\n${SKIPS}\n\`\`\`\n"
  fi
  # Escape for JSON: newlines → \n, quotes → \"
  ESCAPED=$(printf '%s' "$PAYLOAD" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo "\"$PAYLOAD\"")
  curl -s -X POST "$DISCORD_WEBHOOK_URL" \
    -H "content-type: application/json" \
    -d "{\"content\": ${ESCAPED}}" \
    >/dev/null 2>&1 || echo "discord webhook failed"
fi

# 6. Slack webhook
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  MSG=""
  [[ -n "$OPENS" ]] && MSG+=$'📈 New signals\n```\n'"$OPENS"$'\n```\n'
  [[ -n "$CLOSES" ]] && MSG+=$'📊 Closed\n```\n'"$CLOSES"$'\n```\n'
  ESCAPED=$(printf '%s' "$MSG" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo "\"$MSG\"")
  curl -s -X POST "$SLACK_WEBHOOK_URL" \
    -H "content-type: application/json" \
    -d "{\"text\": ${ESCAPED}}" \
    >/dev/null 2>&1 || echo "slack webhook failed"
fi
