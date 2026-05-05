"""
Unit tests for tools/health_monitor.py.

Run:
    cd /path/to/tradevision-ai
    python -m pytest tools/test_health_monitor.py -v

Covers (Runde 4 audit deferred-item fix):
- check_account_freshness(): stale account.json detected
- check_account_freshness(): fresh account.json passes
- check_account_freshness(): missing state-dir / missing account.json handling
- _alert() throttling: 2nd call within cooldown is suppressed
- _redact(): bot-token redaction in error strings
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


TOOLS = Path(__file__).parent
sys.path.insert(0, str(TOOLS))


@pytest.fixture
def hm(tmp_path, monkeypatch):
    """Reload health_monitor with FTMO_STATE_DIR pointing into tmp_path."""
    monkeypatch.setenv("FTMO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("FTMO_ACCOUNT_ID", raising=False)
    if "health_monitor" in sys.modules:
        del sys.modules["health_monitor"]
    return importlib.import_module("health_monitor")


def _write_account(state_dir: Path, last_iso: str) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "account.json").write_text(json.dumps({
        "lastUpdateUtc": last_iso,
        "balance": 100000.0,
    }))


# ============================================================================
# check_account_freshness
# ============================================================================
def test_freshness_detects_stale(hm):
    """account.json older than HEALTH_STALE_MINUTES → returns error string."""
    sd = hm._state_dir()
    stale_iso = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
    _write_account(sd, stale_iso)
    err = hm.check_account_freshness()
    assert err is not None
    assert "stale" in err.lower()


def test_freshness_passes_when_fresh(hm):
    """account.json updated within threshold → returns None."""
    sd = hm._state_dir()
    fresh_iso = datetime.now(timezone.utc).isoformat()
    _write_account(sd, fresh_iso)
    assert hm.check_account_freshness() is None


def test_freshness_missing_account_json(hm):
    """account.json missing → returns descriptive error (no crash)."""
    sd = hm._state_dir()
    sd.mkdir(parents=True, exist_ok=True)  # state-dir exists but no account.json
    err = hm.check_account_freshness()
    assert err is not None
    assert "missing" in err.lower()


def test_state_dir_missing_handled(hm):
    """check_state_dir_exists returns error if dir not created (bot never booted)."""
    err = hm.check_state_dir_exists()
    assert err is not None
    assert "missing" in err.lower() or "never booted" in err.lower()


# ============================================================================
# _alert throttling
# ============================================================================
def test_alert_throttle_suppresses_second_call(hm, monkeypatch, capsys):
    """Second alert with same error_type within cooldown is suppressed."""
    # No Telegram creds → _alert prints + persists timestamp but returns False.
    # First call writes timestamp; second call within cooldown hits "suppressed" branch.
    sd = hm._state_dir()
    sd.mkdir(parents=True, exist_ok=True)

    # 1st call: persists timestamp (no creds → returns False, but state written).
    hm._alert("test_err", "first message")

    # 2nd call: state file says we just alerted → suppression branch.
    sent = hm._alert("test_err", "second message")
    assert sent is False
    out = capsys.readouterr().out
    assert "suppressed test_err" in out


def test_alert_throttle_allows_after_cooldown(hm):
    """After cooldown elapses, a fresh alert is allowed (state mtime older)."""
    sd = hm._state_dir()
    sd.mkdir(parents=True, exist_ok=True)
    # Manually seed alert-state with a timestamp older than cooldown.
    old_ts = time.time() - hm.ALERT_COOLDOWN_SEC - 60
    hm._write_alert_state({"test_err": old_ts})
    # No creds → returns False, but should NOT take the "suppressed" branch.
    # We verify by checking state was overwritten with a fresh timestamp.
    hm._alert("test_err", "fresh message")
    state = hm._read_alert_state()
    assert state["test_err"] > old_ts + 60  # advanced past the seeded value


# ============================================================================
# _redact
# ============================================================================
def test_redact_strips_bot_token(hm):
    """Bot tokens of form /bot<digits>:<chars> are replaced with /bot<REDACTED>."""
    raw = "HTTP error: https://api.telegram.org/bot1234567:ABC-def_xyz123/sendMessage failed"
    out = hm._redact(raw)
    assert "1234567" not in out
    assert "ABC-def_xyz123" not in out
    assert "/bot<REDACTED>" in out


def test_redact_passthrough_when_no_token(hm):
    """Strings with no bot token are returned unchanged."""
    msg = "connection refused: timeout after 5s"
    assert hm._redact(msg) == msg
