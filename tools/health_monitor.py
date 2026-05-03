"""
Bot Health Monitor — runs as separate cron / PM2 process.

Periodically checks if the FTMO bot is alive. Sends Telegram alert if:
  1. Account state file (`account.json`) hasn't been updated in > N minutes
  2. Executor log file is missing or hasn't appended in > 2N minutes
  3. Disk space < 500 MB
  4. State-dir doesn't exist (bot never booted)

Self-throttles: alerts at most once every 30 minutes per error type.

Usage (PM2 separate process):
    pm2 start tools/health_monitor.py --name ftmo-health --interpreter python3 \
      --cron-restart="*/15 * * * *"

Or as cron job:
    */15 * * * * cd /path/to/tradevision-ai && python3 tools/health_monitor.py

Env vars (same as ftmo_executor):
    FTMO_TF                    — strategy timeframe (used to find state-dir)
    FTMO_ACCOUNT_ID            — account ID (multi-account)
    FTMO_STATE_DIR             — explicit state-dir override
    TELEGRAM_BOT_TOKEN[_<ID>]  — for alerts
    TELEGRAM_CHAT_ID[_<ID>]    — for alerts
    HEALTH_STALE_MINUTES       — default 5 (account.json stale threshold)
    HEALTH_DISK_MIN_MB         — default 500
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request as urlreq
from urllib.error import HTTPError, URLError


# =============================================================================
# Config
# =============================================================================

STALE_MINUTES = int(os.environ.get("HEALTH_STALE_MINUTES", "5"))
DISK_MIN_MB = int(os.environ.get("HEALTH_DISK_MIN_MB", "500"))
ALERT_COOLDOWN_SEC = 30 * 60  # 30min between same-type alerts


def _state_dir() -> Path:
    explicit = os.environ.get("FTMO_STATE_DIR")
    if explicit:
        return Path(explicit)
    tf = os.environ.get("FTMO_TF", "default")
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    if aid:
        return Path.cwd() / f"ftmo-state-{tf}-{aid}"
    return Path.cwd() / f"ftmo-state-{tf}"


def _telegram_creds() -> tuple[str | None, str | None]:
    aid = os.environ.get("FTMO_ACCOUNT_ID")
    token = (
        os.environ.get(f"TELEGRAM_BOT_TOKEN_{aid}") if aid else None
    ) or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = (
        os.environ.get(f"TELEGRAM_CHAT_ID_{aid}") if aid else None
    ) or os.environ.get("TELEGRAM_CHAT_ID")
    return token, chat


def _redact(s: str) -> str:
    return re.sub(r"/bot\d+:[A-Za-z0-9_-]+", "/bot<REDACTED>", s)


def _alert_state_path() -> Path:
    """Where we persist last-alert timestamps to throttle re-alerts."""
    return _state_dir() / ".health_alerts.json"


def _read_alert_state() -> dict[str, float]:
    p = _alert_state_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_alert_state(state: dict[str, float]) -> None:
    p = _alert_state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2))


def _alert(error_type: str, msg: str) -> bool:
    """Send Telegram alert if not throttled. Returns True if sent."""
    state = _read_alert_state()
    last = state.get(error_type, 0)
    if time.time() - last < ALERT_COOLDOWN_SEC:
        print(f"[health-monitor] suppressed {error_type} (last alert {int((time.time()-last)/60)}min ago)")
        return False
    token, chat = _telegram_creds()
    if not token or not chat:
        print(f"[health-monitor] {error_type}: {msg} (no Telegram creds — printing only)")
        state[error_type] = time.time()
        _write_alert_state(state)
        return False
    aid = os.environ.get("FTMO_ACCOUNT_ID", "?")
    full_msg = f"🚨 [{aid}] {msg}"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({"chat_id": chat, "text": full_msg}).encode("utf-8")
    req = urlreq.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urlreq.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                state[error_type] = time.time()
                _write_alert_state(state)
                print(f"[health-monitor] alerted: {error_type}")
                return True
    except (HTTPError, URLError) as e:
        print(f"[health-monitor] Telegram failed: {_redact(str(e))}")
    state[error_type] = time.time()
    _write_alert_state(state)
    return False


# =============================================================================
# Health checks
# =============================================================================

def check_state_dir_exists() -> str | None:
    sd = _state_dir()
    if not sd.exists():
        return f"State dir missing: {sd} — bot never booted"
    return None


def check_account_freshness() -> str | None:
    sd = _state_dir()
    acc = sd / "account.json"
    if not acc.exists():
        return f"account.json missing in {sd} — bot dead?"
    try:
        data = json.loads(acc.read_text())
    except (OSError, json.JSONDecodeError) as e:
        return f"account.json unreadable: {e}"
    last_iso = data.get("lastUpdateUtc")
    if not last_iso:
        return "account.json has no lastUpdateUtc field"
    try:
        last_dt = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        age_min = (now - last_dt).total_seconds() / 60
        if age_min > STALE_MINUTES:
            return (
                f"account.json stale {age_min:.1f}min "
                f"(threshold {STALE_MINUTES}min) — bot likely dead"
            )
    except ValueError:
        return f"account.json lastUpdateUtc unparseable: {last_iso!r}"
    return None


def check_executor_log_freshness() -> str | None:
    sd = _state_dir()
    log = sd / "executor-log.jsonl"
    if not log.exists():
        return f"executor-log.jsonl missing in {sd}"
    age_sec = time.time() - log.stat().st_mtime
    age_min = age_sec / 60
    threshold = STALE_MINUTES * 2
    if age_min > threshold:
        return f"executor-log.jsonl not appended in {age_min:.1f}min (threshold {threshold}min)"
    return None


def check_disk_space() -> str | None:
    import shutil
    free = shutil.disk_usage(Path.cwd()).free
    mb = free / (1024**2)
    if mb < DISK_MIN_MB:
        return f"Disk space low: {mb:.0f} MB free (threshold {DISK_MIN_MB} MB)"
    return None


def check_pending_signals_not_stuck() -> str | None:
    """If pending-signals.json has > 5 entries, bot is failing to process."""
    sd = _state_dir()
    p = sd / "pending-signals.json"
    if not p.exists():
        return None  # not yet generated, fine
    try:
        data = json.loads(p.read_text())
        signals = data.get("signals", [])
        if len(signals) > 5:
            return f"pending-signals.json has {len(signals)} stuck entries (bot not processing)"
    except (OSError, json.JSONDecodeError):
        return "pending-signals.json corrupt"
    return None


# =============================================================================
# Main
# =============================================================================

def main() -> int:
    checks = [
        ("state_dir_missing", check_state_dir_exists),
        ("account_stale", check_account_freshness),
        ("log_stale", check_executor_log_freshness),
        ("disk_low", check_disk_space),
        ("signals_stuck", check_pending_signals_not_stuck),
    ]
    issues = 0
    for error_type, fn in checks:
        try:
            err = fn()
        except Exception as e:
            err = f"check {error_type} threw: {e}"
        if err:
            issues += 1
            _alert(error_type, err)
        else:
            print(f"[health-monitor] OK: {error_type}")
    if issues == 0:
        print(f"[health-monitor] all OK ({datetime.now(timezone.utc).isoformat()})")
        return 0
    print(f"[health-monitor] {issues} issue(s) detected")
    return 1


if __name__ == "__main__":
    sys.exit(main())
