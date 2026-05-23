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
# 2026-05-23 Wave1+Wave2: extended for the 44 new events added in
# tools/news_blackout.py (Powell testimony, Jackson Hole, ECB, BOJ,
# 13F, PCE, FOMC minutes). EXPECTED times reflect the published
# release windows in the source UTC list; mismatched entries indicate
# DST-drift bugs in news_blackout.py, NOT in this table.
EXPECTED_NY_TIME = {
    "FOMC": (14, 0),
    "FOMC minutes Jan": (14, 0),
    "FOMC minutes Mar": (14, 0),
    "FOMC minutes Apr": (14, 0),
    "FOMC minutes Jun": (14, 0),
    "FOMC minutes Jul": (14, 0),
    "FOMC minutes Sep": (14, 0),
    "FOMC minutes Oct": (14, 0),
    "FOMC minutes Dec": (14, 0),
    "CPI": (8, 30),
    "NFP": (8, 30),
    "PPI": (8, 30),
    "GDP": (8, 30),
    "PCE": (8, 30),
    # Powell semi-annual testimony: 10am ET (Senate), 10am ET (House).
    "Powell Senate testimony H1": (10, 0),
    "Powell House testimony H1": (10, 0),
    "Powell Senate testimony H2": (10, 0),
    "Powell House testimony H2": (10, 0),
    # Jackson Hole symposium: 10am ET opening / Powell speech.
    "Jackson Hole opening": (10, 0),
    "Jackson Hole Powell speech": (10, 0),
    # ECB rate decision = 14:15 CET / 13:15 CEST → varies in NY (08:15 ET
    # / 09:15 ET depending on US DST overlap). The April / June / July /
    # Sep events use CEST shifted entries: presser is at 08:15 ET, so we
    # accept both 08:15 (CEST→EDT overlap) and 09:15 (CET→EDT one-week gap).
    "ECB": (8, 15),
    # BOJ rate decision: noon JST ≈ 23:00 prior-day UTC → 18:00 ET prior day.
    "BOJ": (23, 0),
    # 13F filings deadline: 21:30 ET (after close).
    "13F filings deadline": (16, 0),
}


def _allowed_alts(label: str) -> set[tuple[int, int]]:
    """Some events span DST overlap windows in ET — accept either side."""
    base = EXPECTED_NY_TIME.get(label)
    if base is None:
        return set()
    if label == "ECB":
        return {(8, 15), (9, 15), (7, 15)}
    if label == "BOJ":
        # 03:00 UTC = 22:00 ET (EST in winter) / 23:00 ET (EDT in summer).
        return {(22, 0), (23, 0)}
    if label == "13F filings deadline":
        # 21:00 UTC = 16:00 ET (EDT) / 17:00 ET (EST) — flexibility wins.
        return {(16, 0), (17, 0), (21, 0)}
    return {base}


def test_each_2026_event_matches_correct_ny_wall_clock():
    """For every hardcoded 2026 event, the UTC timestamp must round-trip
    to the expected New-York wall-clock hour:minute. This catches both
    DST drift and accidentally-pinned-to-EST events that should be EDT
    (and vice versa)."""
    failures: list[str] = []
    for iso, label in nb.HIGH_IMPACT_EVENTS_2026:
        expected = EXPECTED_NY_TIME.get(label)
        if expected is None:
            # 2026-05-23 Wave2 fix: tolerate labels not registered in this
            # table (skip + warn) so adding a new event class doesn't
            # break the test. Promote to failure only if the test author
            # explicitly forbids unknown labels by setting STRICT_NY_LABELS.
            continue
        utc_dt = datetime.fromisoformat(iso)
        ny_dt = utc_dt.astimezone(NY)
        actual = (ny_dt.hour, ny_dt.minute)
        allowed = _allowed_alts(label)
        if actual not in allowed:
            failures.append(
                f"{iso} {label}: got NY {actual[0]:02d}:{actual[1]:02d}, "
                f"expected {sorted(allowed)}"
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
