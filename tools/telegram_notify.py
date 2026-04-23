"""
Minimal Telegram notifier for the Python executor.
Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
Silent no-op if not configured. Never raises.
"""
from __future__ import annotations

import os
import urllib.request
import json


def tg_send(text: str) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False
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
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        print(f"[telegram] send error: {e}")
        return False


def html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
