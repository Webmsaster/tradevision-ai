#!/bin/bash
# Timing-Supervisor cron wrapper
# Installed via crontab: */30 * * * * /home/flooe/projects/tradevision-ai/scripts/timing_cron_wrapper.sh
cd /home/flooe/projects/tradevision-ai || exit 1
# Source Telegram creds if file exists
[ -f tools/.env ] && source tools/.env
export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
/usr/bin/python3 scripts/ftmo_timing_supervisor.py >> /tmp/timing_supervisor.log 2>&1
