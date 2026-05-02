"""
Macro news-blackout filter for crypto FTMO bot.

High-impact USD economic events (FOMC, CPI, NFP, PPI, GDP) cause sharp
crypto vol spikes that historically tag SLs and burn 5% daily-loss caps.
This module mirrors the forex-side `src/utils/forexFactoryNews.ts`
`isNewsBlackout` logic, but uses a hardcoded event list (no live feed)
so it works fully offline without an API key.

Public API:
    is_blackout_window(now_utc, blackout_minutes_before=30,
                       blackout_minutes_after=60) -> (is_blocked, reason)
    next_event_within(hours, now_utc=None) -> dict | None
    refresh_from_api(cache_path=None, force=False) -> int

Hardcoded events list — 2026 schedule.
- FOMC rate decisions: 8 per year, statement at 18:00 UTC.
- CPI: monthly, ~12-13th, 12:30 UTC.
- NFP: first Friday of each month, 12:30 UTC.
- PPI: monthly, ~13-14th, 12:30 UTC.
- GDP advance: quarterly (Jan, Apr, Jul, Oct), 12:30 UTC.

NB: Times are official BLS / Fed release times in UTC. Crypto desks
     front-run by 5-15 min and reactions linger 30-90 min, hence the
     default 30/60 buffer split.

Optional live feed (Round 53+):
    Set NEWS_API_KEY=<finnhub-token> to enable auto-refresh from the
    Finnhub economic-calendar API. Cache lives in
    NEWS_CACHE_PATH (default: ./ftmo-state-*/news-cache.json) with a
    24h TTL. Set NEWS_API_DISABLED=true to opt out and force the
    hardcoded list. The module stays offline-first: any failure falls
    back to HIGH_IMPACT_EVENTS_2026 silently.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional


# =============================================================================
# Hardcoded high-impact USD events for 2026
# =============================================================================
# Each entry: (iso_utc_timestamp, label)
# Times are release moments in UTC. ISO strings parse to tz-aware datetimes.
HIGH_IMPACT_EVENTS_2026: list[tuple[str, str]] = [
    # ---- FOMC rate decisions (8/year, statement 18:00 UTC) ----
    ("2026-01-28T19:00:00+00:00", "FOMC"),
    ("2026-03-18T18:00:00+00:00", "FOMC"),
    ("2026-04-29T18:00:00+00:00", "FOMC"),
    ("2026-06-17T18:00:00+00:00", "FOMC"),
    ("2026-07-29T18:00:00+00:00", "FOMC"),
    ("2026-09-16T18:00:00+00:00", "FOMC"),
    ("2026-10-28T18:00:00+00:00", "FOMC"),
    ("2026-12-09T19:00:00+00:00", "FOMC"),

    # ---- CPI (monthly, mid-month, 12:30 UTC) ----
    ("2026-01-13T13:30:00+00:00", "CPI"),
    ("2026-02-12T13:30:00+00:00", "CPI"),
    ("2026-03-12T12:30:00+00:00", "CPI"),
    ("2026-04-14T12:30:00+00:00", "CPI"),
    ("2026-05-13T12:30:00+00:00", "CPI"),
    ("2026-06-11T12:30:00+00:00", "CPI"),
    ("2026-07-15T12:30:00+00:00", "CPI"),
    ("2026-08-12T12:30:00+00:00", "CPI"),
    ("2026-09-11T12:30:00+00:00", "CPI"),
    ("2026-10-14T12:30:00+00:00", "CPI"),
    ("2026-11-12T13:30:00+00:00", "CPI"),
    ("2026-12-10T13:30:00+00:00", "CPI"),

    # ---- NFP (first Friday of month, 12:30 UTC) ----
    ("2026-01-02T13:30:00+00:00", "NFP"),
    ("2026-02-06T13:30:00+00:00", "NFP"),
    ("2026-03-06T13:30:00+00:00", "NFP"),
    ("2026-04-03T12:30:00+00:00", "NFP"),
    ("2026-05-01T12:30:00+00:00", "NFP"),
    ("2026-06-05T12:30:00+00:00", "NFP"),
    ("2026-07-03T12:30:00+00:00", "NFP"),
    ("2026-08-07T12:30:00+00:00", "NFP"),
    ("2026-09-04T12:30:00+00:00", "NFP"),
    ("2026-10-02T12:30:00+00:00", "NFP"),
    ("2026-11-06T13:30:00+00:00", "NFP"),
    ("2026-12-04T13:30:00+00:00", "NFP"),

    # ---- PPI (monthly, ~13-14th, 12:30 UTC) ----
    ("2026-01-14T13:30:00+00:00", "PPI"),
    ("2026-02-13T13:30:00+00:00", "PPI"),
    ("2026-03-13T12:30:00+00:00", "PPI"),
    ("2026-04-15T12:30:00+00:00", "PPI"),
    ("2026-05-14T12:30:00+00:00", "PPI"),
    ("2026-06-12T12:30:00+00:00", "PPI"),
    ("2026-07-16T12:30:00+00:00", "PPI"),
    ("2026-08-13T12:30:00+00:00", "PPI"),
    ("2026-09-10T12:30:00+00:00", "PPI"),
    ("2026-10-15T12:30:00+00:00", "PPI"),
    ("2026-11-13T13:30:00+00:00", "PPI"),
    ("2026-12-11T13:30:00+00:00", "PPI"),

    # ---- GDP advance (quarterly, 12:30 UTC) ----
    ("2026-01-29T13:30:00+00:00", "GDP"),
    ("2026-04-29T12:30:00+00:00", "GDP"),
    ("2026-07-30T12:30:00+00:00", "GDP"),
    ("2026-10-29T12:30:00+00:00", "GDP"),
]


def _parse_events() -> list[tuple[datetime, str]]:
    """Lazily parse the ISO event list once into tz-aware datetimes."""
    out: list[tuple[datetime, str]] = []
    for iso, label in HIGH_IMPACT_EVENTS_2026:
        dt = datetime.fromisoformat(iso)
        # Defensive: enforce UTC even if the ISO had no offset
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        out.append((dt, label))
    return out


_EVENTS_CACHE: list[tuple[datetime, str]] | None = None


# =============================================================================
# Live-feed (optional) — Finnhub economic calendar
# =============================================================================
# Cache TTL — refresh skipped if file mtime newer than this many seconds.
_CACHE_TTL_SECONDS = 24 * 3600
_API_TIMEOUT_SECONDS = 10
# Match FOMC|CPI|NFP|PPI|GDP keywords in the event title (case-insensitive).
# NFP shows up on Finnhub as "Nonfarm Payrolls" so the regex includes both.
_KEYWORD_RE = re.compile(
    r"\b(FOMC|Federal Funds|CPI|Consumer Price|"
    r"NFP|Nonfarm Payrolls?|PPI|Producer Price|"
    r"GDP|Gross Domestic Product)\b",
    re.IGNORECASE,
)


def _log(msg: str) -> None:
    """Self-contained stderr logger (no dependency on ftmo_executor.log_event)."""
    print(f"[news_blackout] {msg}", file=sys.stderr)


def _default_cache_path() -> Path:
    """
    Resolve the default cache path. NEWS_CACHE_PATH wins; otherwise we
    derive it from FTMO_STATE_DIR / FTMO_TF / FTMO_ACCOUNT_ID so it lines
    up with the per-account state directories used by ftmo_executor.
    """
    explicit = os.environ.get("NEWS_CACHE_PATH")
    if explicit:
        return Path(explicit)
    state_dir_env = os.environ.get("FTMO_STATE_DIR")
    if state_dir_env:
        base = Path(state_dir_env)
    else:
        tf = os.environ.get("FTMO_TF", "default")
        acc = os.environ.get("FTMO_ACCOUNT_ID")
        if acc:
            base = Path(f"./ftmo-state-{tf}-{acc}")
        else:
            base = Path(f"./ftmo-state-{tf}")
    return base / "news-cache.json"


def _cache_is_fresh(cache_path: Path) -> bool:
    """True if the cache file exists and is younger than _CACHE_TTL_SECONDS."""
    try:
        st = cache_path.stat()
    except (OSError, FileNotFoundError):
        return False
    age = datetime.now(timezone.utc).timestamp() - st.st_mtime
    return age < _CACHE_TTL_SECONDS


def _read_cache(cache_path: Path) -> list[tuple[datetime, str]]:
    """
    Parse cache file into the same tuple shape used by _parse_events.
    Returns [] on any error (missing, corrupt, wrong shape, bad ISO).
    """
    try:
        raw = cache_path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[tuple[datetime, str]] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        iso = entry.get("iso")
        label = entry.get("label")
        if not isinstance(iso, str) or not isinstance(label, str):
            continue
        try:
            dt = datetime.fromisoformat(iso)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        out.append((dt, label))
    return out


def _classify_label(event_title: str) -> Optional[str]:
    """Map a Finnhub event title to one of our short labels, or None to skip."""
    title_upper = event_title.upper()
    if "FOMC" in title_upper or "FEDERAL FUNDS" in title_upper:
        return "FOMC"
    if "CPI" in title_upper or "CONSUMER PRICE" in title_upper:
        return "CPI"
    if "NONFARM PAYROLL" in title_upper or "NFP" in title_upper:
        return "NFP"
    if "PPI" in title_upper or "PRODUCER PRICE" in title_upper:
        return "PPI"
    if "GDP" in title_upper or "GROSS DOMESTIC PRODUCT" in title_upper:
        return "GDP"
    return None


def refresh_from_api(
    cache_path: Optional[Path] = None,
    force: bool = False,
) -> int:
    """
    Fetch high-impact USD events for the next 90 days from Finnhub.io
    and write to a JSON cache. Returns the number of events written, or
    0 on any failure / opt-out / missing key.

    Never raises — every failure path logs to stderr and returns 0.

    Env-vars:
        NEWS_API_KEY        — Finnhub token. If missing → returns 0.
        NEWS_API_DISABLED   — "true" to fully opt out → returns 0.
        NEWS_CACHE_PATH     — override default cache path.
    """
    if os.environ.get("NEWS_API_DISABLED", "").lower() == "true":
        return 0

    api_key = os.environ.get("NEWS_API_KEY", "").strip()
    if not api_key:
        # Silent: this is the offline-first default state.
        return 0

    if cache_path is None:
        cache_path = _default_cache_path()

    if not force and _cache_is_fresh(cache_path):
        # Cache is hot — no refresh needed.
        return 0

    now = datetime.now(timezone.utc)
    date_from = now.date().isoformat()
    date_to = (now + timedelta(days=90)).date().isoformat()
    url = (
        "https://finnhub.io/api/v1/calendar/economic"
        f"?from={date_from}&to={date_to}&token={api_key}"
    )

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "tradevision-ai/news_blackout"},
        )
        with urllib.request.urlopen(req, timeout=_API_TIMEOUT_SECONDS) as resp:
            payload = resp.read().decode("utf-8")
        data = json.loads(payload)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        _log(f"api fetch failed: {exc}")
        return 0
    except json.JSONDecodeError as exc:
        _log(f"api response not JSON: {exc}")
        return 0
    except Exception as exc:  # noqa: BLE001 — last-resort offline-first guard
        _log(f"unexpected error during refresh: {exc}")
        return 0

    # Finnhub returns {"economicCalendar": [ {country, event, impact, time, ...}, ... ]}
    events_raw = data.get("economicCalendar") if isinstance(data, dict) else None
    if not isinstance(events_raw, list):
        _log("api response missing economicCalendar list")
        return 0

    written: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for entry in events_raw:
        if not isinstance(entry, dict):
            continue
        country = str(entry.get("country", "")).upper()
        impact = str(entry.get("impact", "")).lower()
        event_title = str(entry.get("event", ""))
        time_str = str(entry.get("time", ""))
        if country not in ("US", "USA"):
            continue
        if impact != "high":
            continue
        if not _KEYWORD_RE.search(event_title):
            continue
        label = _classify_label(event_title)
        if label is None:
            continue
        # Finnhub time format is "YYYY-MM-DD HH:MM:SS" in UTC.
        try:
            dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
            dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        iso = dt.isoformat()
        key = (iso, label)
        if key in seen:
            continue
        seen.add(key)
        written.append({"iso": iso, "label": label})

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
        tmp.write_text(json.dumps(written, indent=2), encoding="utf-8")
        tmp.replace(cache_path)
    except OSError as exc:
        _log(f"cache write failed: {exc}")
        return 0

    # Invalidate in-process cache so next _events() call picks up the new file.
    global _EVENTS_CACHE
    _EVENTS_CACHE = None

    _log(f"refreshed {len(written)} events → {cache_path}")
    return len(written)


def _events() -> list[tuple[datetime, str]]:
    """
    Return the active event list. Prefers a fresh cache file if present
    and parseable, otherwise falls back to HIGH_IMPACT_EVENTS_2026.
    """
    global _EVENTS_CACHE
    if _EVENTS_CACHE is not None:
        return _EVENTS_CACHE

    if os.environ.get("NEWS_API_DISABLED", "").lower() != "true":
        try:
            cache_path = _default_cache_path()
            cached = _read_cache(cache_path)
            if cached:
                _EVENTS_CACHE = cached
                return _EVENTS_CACHE
        except Exception as exc:  # noqa: BLE001 — never break the bot
            _log(f"cache read fallback to hardcoded: {exc}")

    _EVENTS_CACHE = _parse_events()
    return _EVENTS_CACHE


# =============================================================================
# Public API
# =============================================================================
def is_blackout_window(
    now_utc: datetime,
    blackout_minutes_before: int = 30,
    blackout_minutes_after: int = 60,
) -> tuple[bool, Optional[str]]:
    """
    Check whether `now_utc` falls inside any high-impact event blackout.

    Window for each event E is [E - before_min, E + after_min].
    Returns (True, "<LABEL> @ <iso>") on first match, else (False, None).
    """
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    for evt_dt, label in _events():
        delta_min = (evt_dt - now_utc).total_seconds() / 60.0
        # Positive delta = event is in future, negative = in past
        if -blackout_minutes_after <= delta_min <= blackout_minutes_before:
            reason = f"{label} @ {evt_dt.isoformat()} (Δ {delta_min:+.1f}min)"
            return True, reason
    return False, None


def next_event_within(
    hours: int,
    now_utc: Optional[datetime] = None,
) -> Optional[dict]:
    """
    Return the next high-impact event within `hours` from `now_utc`,
    or None if no event upcoming in that horizon. Used for telemetry.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    horizon_min = hours * 60.0
    soonest: Optional[tuple[datetime, str, float]] = None
    for evt_dt, label in _events():
        delta_min = (evt_dt - now_utc).total_seconds() / 60.0
        if 0 <= delta_min <= horizon_min:
            if soonest is None or delta_min < soonest[2]:
                soonest = (evt_dt, label, delta_min)
    if soonest is None:
        return None
    evt_dt, label, delta_min = soonest
    return {
        "label": label,
        "iso": evt_dt.isoformat(),
        "minutes_until": round(delta_min, 1),
    }
