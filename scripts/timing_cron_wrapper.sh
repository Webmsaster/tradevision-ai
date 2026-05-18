#!/bin/bash
# Timing-Supervisor cron wrapper
# Installed via crontab: */30 * * * * /home/flooe/projects/tradevision-ai/scripts/timing_cron_wrapper.sh
#
# 2026-05-18 Bug-Audit fix: flock prevents two instances running in parallel
# (which would race on TMP_OUT + timing-gate.json writes).
set -euo pipefail
cd /home/flooe/projects/tradevision-ai || exit 1

LOCK_FILE=/tmp/timing_supervisor.lock
LOG_FILE=/tmp/timing_supervisor.log

# Use flock -n: bail immediately if another instance is still running
# (a long supervisor run > 30min would otherwise stack up).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "$(date -Iseconds) [skip] another supervisor instance is running" >> "$LOG_FILE"
    exit 0
fi

# Source Telegram creds if file exists
[ -f tools/.env ] && set -a && . tools/.env && set +a

/usr/bin/python3 scripts/ftmo_timing_supervisor.py >> "$LOG_FILE" 2>&1
