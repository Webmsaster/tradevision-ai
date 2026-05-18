#!/bin/bash
# LSR cron wrapper — ensures correct working directory + python path.
# Installed via crontab as: */30 * * * * /home/flooe/projects/tradevision-ai/scripts/lsr_cron_wrapper.sh
cd /home/flooe/projects/tradevision-ai || exit 1
/usr/bin/python3 scripts/lsr_collector.py >> /tmp/lsr_collector.log 2>&1
