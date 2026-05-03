"""
Minimal Telegram notifier for the Python executor.
Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
Silent no-op if not configured. Never raises.

Round 55 audit hardening (2026-05-03):
- Token-redaction in error logs (prevent /botXXX:YYY/sendMessage leaks).
- Reduced timeout from 10s → 3s (10s blocked the trade loop on outages).
- 429/5xx → 60s suppression cooldown (prevent ban-spam).
- 401/404 → permanent suppression (invalid token / blocked bot — needs restart).

Round 57 multi-account hardening (2026-05-03):
- Per-account token + chat-id resolution. Env precedence:
    TELEGRAM_BOT_TOKEN_<FTMO_ACCOUNT_ID>  →  TELEGRAM_BOT_TOKEN
    TELEGRAM_CHAT_ID_<FTMO_ACCOUNT_ID>    →  TELEGRAM_CHAT_ID
  Two parallel demo accounts can either share one bot+chat (legacy fallback)
  or use independent ones to avoid mixed alerts.
- Outgoing alerts are prefixed with `[acct:<FTMO_ACCOUNT_ID>]` when
  FTMO_ACCOUNT_ID is set so the chat is unambiguous.
"""
from __future__ import annotations

import os
import re
import time
import urllib.request
import urllib.error
import json


# Module-level suppression state.
# `_suppress_until_ts == 0`        → no suppression
# `_suppress_until_ts == time + N` → suppress until that wall-clock
# `_suppress_until_ts == inf`      → permanent (process restart required)
_suppress_until_ts: float = 0.0
_suppress_logged: bool = False  # log "[telegram] suppressed until X" only once

# Match `/bot<digits>:<token-chars>` in any string and redact.
_TOKEN_RE = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")


def _redact(s: str) -> str:
    """Strip Telegram bot-token from any error/diagnostic string."""
    return _TOKEN_RE.sub("/bot<REDACTED>", s)


def _enter_suppression(seconds: float, reason: str) -> None:
    """Start a suppression window. Logs once on entry."""
    global _suppress_until_ts, _suppress_logged
    _suppress_until_ts = time.time() + seconds if seconds != float("inf") else float("inf")
    if not _suppress_logged:
        if seconds == float("inf"):
            print(f"[telegram] permanently suppressed: {reason}")
        else:
            print(f"[telegram] suppressed until {_suppress_until_ts:.0f} ({reason})")
        _suppress_logged = True


def _clear_suppression() -> None:
    """Successful send clears suppression state."""
    global _suppress_until_ts, _suppress_logged
    _suppress_until_ts = 0.0
    _suppress_logged = False


def _resolve_account_env(base: str) -> str | None:
    """
    Resolve `TELEGRAM_<base>_<FTMO_ACCOUNT_ID>` first, fall back to
    `TELEGRAM_<base>`. Returns the value or None if neither is set.

    The account id is sanitised — only [A-Za-z0-9_] are kept so a stray
    space/dash in FTMO_ACCOUNT_ID can't break env-var resolution.
    """
    acct = os.environ.get("FTMO_ACCOUNT_ID", "").strip()
    if acct:
        safe = re.sub(r"[^A-Za-z0-9_]", "_", acct)
        per_acct = os.environ.get(f"TELEGRAM_{base}_{safe}")
        if per_acct:
            return per_acct
    return os.environ.get(f"TELEGRAM_{base}") or None


def _account_prefix() -> str:
    """`[acct:<id>] ` if FTMO_ACCOUNT_ID set, else empty string."""
    acct = os.environ.get("FTMO_ACCOUNT_ID", "").strip()
    return f"[acct:{acct}] " if acct else ""


def tg_send(text: str) -> bool:
    token = _resolve_account_env("BOT_TOKEN")
    chat_id = _resolve_account_env("CHAT_ID")
    if not token or not chat_id:
        return False
    # Suppression-active → skip without hitting urlopen.
    if time.time() < _suppress_until_ts:
        return False
    # Round 57: prefix with account id for multi-account chats. Prefix counts
    # toward the 4000-char Telegram budget so we apply it before truncation.
    text = _account_prefix() + text
    if len(text) > 4000:
        text = text[:3980] + "\n…(truncated)"
    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=json.dumps({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }).encode("utf-8"),
        )
        # Round 55: 3s timeout (was 10s — too long; blocked the trade loop
        # for 6+ seconds during Telegram outages).
        with urllib.request.urlopen(req, timeout=3) as resp:
            ok = 200 <= resp.status < 300
            if ok:
                _clear_suppression()
            return ok
    except urllib.error.HTTPError as e:
        # Telegram returned an HTTP error code. Inspect status to decide
        # whether to enter a suppression window. NEVER print `e.url` or `e`
        # directly — they typically contain the bot-token.
        status = getattr(e, "code", 0)
        msg = _redact(str(e))
        if status in (401, 404):
            # Invalid token / bot blocked → permanent suppression until restart.
            print(f"[telegram] auth/bot error {status}: {msg}")
            _enter_suppression(float("inf"), f"HTTP {status}")
        elif status == 429 or 500 <= status < 600:
            # Rate-limited or server error → 60s cooldown.
            print(f"[telegram] backoff {status}: {msg}")
            _enter_suppression(60.0, f"HTTP {status}")
        else:
            print(f"[telegram] send error {status}: {msg}")
        return False
    except Exception as e:
        # Network / DNS / timeout. Redact in case the exception text
        # contains the URL (some libs format `e.filename` with the URL).
        print(f"[telegram] send error: {_redact(str(e))}")
        return False


def html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
