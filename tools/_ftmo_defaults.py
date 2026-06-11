"""Shared FTMO toolkit defaults — single source of truth.

2026-05-15 (Audit-Round-4 / Agent #9 HIGH): the FTMO_TF default was diverging
across the toolkit:

    ftmo_executor.py    → "1h"                                  (legacy)
    ftmo_kill.py        → "2h-trend-v5-r28-v6-passlock"          (prev champion)
    health_monitor.py   → "default"                              (catch-all)
    news_blackout.py    → "default"                              (catch-all)
    preflight_check.py  → "default"                              (catch-all)

When the user forgot to export FTMO_TF, each tool resolved a different
state-dir → ftmo_kill wrote `pause-marker` into one directory while
ftmo_executor was reading from another → kill-switch effectively broken.

This module centralises the default. All five files import DEFAULT_FTMO_TF
and resolve identically. The value tracks the active champion in CLAUDE.md
(currently AMBER_MAX_PASSLOCK as of 2026-05-15). If you flip the champion,
update it here and all tools follow.

The user is still expected to set FTMO_TF explicitly in production; this
default is only the fallback safety-net.
"""

# Active live champion (2026-05-15). Update when the champion rotates.
DEFAULT_FTMO_TF: str = "2h-trend-v5-amber-max-passlock"
