"""
DST validation for the hardcoded HIGH_IMPACT_EVENTS_2026 list in
tools/news_blackout.py.

R67-r21 audit follow-up: the event-time UTC offsets must match the
correct US-Eastern wall-clock hour, accounting for DST transitions:
  - FOMC statement at 14:00 ET  → 18:00 UTC (EDT) / 19:00 UTC (EST)
  - US 8:30am releases (CPI/NFP/PPI/GDP) → 12:30 UTC (EDT) / 13:30 UTC (EST)

US-DST transitions (2026): starts 2026-03-08 (clocks forward), ends
2026-11-01 (clocks back). Events between those dates are EDT; otherwise
EST.

Run:
    cd /path/to/tradevision-ai/tools
    python -m pytest test_news_blackout_dst.py -v
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

import news_blackout as nb  # type: ignore  # noqa: E402

NY = ZoneInfo("America/New_York")

# Expected wall-clock hour:minute in New York for each event label.
EXPECTED_NY_TIME = {
    "FOMC": (14, 0),
    "CPI": (8, 30),
    "NFP": (8, 30),
    "PPI": (8, 30),
    "GDP": (8, 30),
}


def test_each_2026_event_matches_correct_ny_wall_clock():
    """For every hardcoded 2026 event, the UTC timestamp must round-trip
    to the expected New-York wall-clock hour:minute. This catches both
    DST drift and accidentally-pinned-to-EST events that should be EDT
    (and vice versa)."""
    failures: list[str] = []
    for iso, label in nb.HIGH_IMPACT_EVENTS_2026:
        expected = EXPECTED_NY_TIME.get(label)
        if expected is None:
            failures.append(f"{iso} {label}: no NY wall-clock expectation registered")
            continue
        utc_dt = datetime.fromisoformat(iso)
        ny_dt = utc_dt.astimezone(NY)
        actual = (ny_dt.hour, ny_dt.minute)
        if actual != expected:
            failures.append(
                f"{iso} {label}: got NY {actual[0]:02d}:{actual[1]:02d}, "
                f"expected {expected[0]:02d}:{expected[1]:02d}"
            )
    assert not failures, "DST drift in HIGH_IMPACT_EVENTS_2026:\n  " + "\n  ".join(
        failures
    )


def test_dst_transition_dates_2026_correct():
    """Sanity-check the assumed US DST boundaries for 2026."""
    # 2026-03-08 02:00 EST → 03:00 EDT.
    pre = datetime(2026, 3, 8, 1, 0, tzinfo=NY)
    post = datetime(2026, 3, 8, 3, 0, tzinfo=NY)
    assert pre.utcoffset().total_seconds() == -5 * 3600  # type: ignore[union-attr]
    assert post.utcoffset().total_seconds() == -4 * 3600  # type: ignore[union-attr]

    # 2026-11-01 02:00 EDT → 01:00 EST (clocks back; pick 1:30 unambiguously
    # by going to 03:00 the same day which is firmly EST).
    after_fall = datetime(2026, 11, 1, 3, 0, tzinfo=NY)
    assert after_fall.utcoffset().total_seconds() == -5 * 3600  # type: ignore[union-attr]
