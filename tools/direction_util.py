"""Direction string normalization helper.

2026-05-23 ML audit Round 11.2 — global fix for ~70 call sites doing strict
`d == "long"` compare. MT5 / Binance / Engine inconsistently emit "long" vs
"Long" vs "LONG" → silent sign-flip on case drift = potential account-blow
in live executor.

Use `is_long(d)` / `is_short(d)` instead of `d == "long"`.
Use `normalize_direction(d)` when you need the canonical lowercase form.
Use `dir_sign(d)` for the ±1 multiplier.
"""

from __future__ import annotations
from typing import Optional


def normalize_direction(d) -> Optional[str]:
    """Returns canonical "long" / "short" or None for unknown.

    Handles: None, empty string, whitespace, any casing, non-string types.
    """
    if d is None:
        return None
    s = str(d).strip().lower()
    if s == "long":
        return "long"
    if s == "short":
        return "short"
    return None


def is_long(d) -> bool:
    return normalize_direction(d) == "long"


def is_short(d) -> bool:
    return normalize_direction(d) == "short"


def dir_sign(d) -> float:
    """Returns +1.0 for long, -1.0 for short, 0.0 for unknown.

    Caller MUST check for 0.0 if unknown-direction must be filtered.
    """
    n = normalize_direction(d)
    if n == "long":
        return 1.0
    if n == "short":
        return -1.0
    return 0.0


def opposite(d) -> Optional[str]:
    n = normalize_direction(d)
    if n == "long":
        return "short"
    if n == "short":
        return "long"
    return None
