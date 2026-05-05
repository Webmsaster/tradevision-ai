"""
Unit tests for tools/process_lock.py — cross-process file lock with
token-based unlink (R44-LIVE-C1) and stale-lock recovery.

Run:
    /usr/bin/python3 -m pytest tools/test_process_lock.py -v
"""
from __future__ import annotations

import os
import sys
import time
import threading
from pathlib import Path

import pytest

TOOLS = Path(__file__).parent
sys.path.insert(0, str(TOOLS))

from process_lock import file_lock, _make_token, _safe_release  # noqa: E402


# ---------------------------------------------------------------------------
# Basic acquire/release
# ---------------------------------------------------------------------------
def test_file_lock_acquires_and_releases(tmp_path: Path):
    lock = tmp_path / "x.lock"
    assert not lock.exists()
    with file_lock(lock):
        # Inside critical section: lock file exists with our token
        assert lock.exists()
        content = lock.read_text()
        assert str(os.getpid()) in content
    # After release: lock removed
    assert not lock.exists()


def test_file_lock_creates_parent_dir(tmp_path: Path):
    lock = tmp_path / "deep" / "nested" / "dir" / "x.lock"
    with file_lock(lock):
        assert lock.exists()
    assert not lock.exists()


# ---------------------------------------------------------------------------
# Stale-lock recovery (R44-LIVE-C1)
# ---------------------------------------------------------------------------
def test_file_lock_force_claims_stale_lock(tmp_path: Path):
    """A lock-file older than stale_sec must be force-claimed after timeout."""
    lock = tmp_path / "stale.lock"
    # Plant a stale lock file with a foreign token
    lock.write_text("99999:0:abadcafe")
    # Force its mtime way in the past
    old = time.time() - 60
    os.utime(str(lock), (old, old))

    # With short timeout + small stale window, our caller should reclaim
    start = time.time()
    with file_lock(lock, timeout_sec=0.05, stale_sec=1.0, backoff_sec=0.01):
        content = lock.read_text()
        assert str(os.getpid()) in content
    elapsed = time.time() - start
    assert elapsed < 2.0  # didn't hang


def test_file_lock_does_not_force_claim_fresh_lock(tmp_path: Path):
    """A fresh foreign lock must NOT be force-claimed even after timeout."""
    lock = tmp_path / "fresh.lock"
    lock.write_text("12345:0:beefcafe")  # foreign, just-now mtime

    # Run acquire in a thread with very short timeout but a long stale_sec.
    # Caller should keep backing off (no exception, no force claim) until
    # we manually clear the lock from the main thread.
    acquired = threading.Event()
    released = threading.Event()

    def worker():
        with file_lock(lock, timeout_sec=0.05, stale_sec=300.0, backoff_sec=0.01):
            acquired.set()
        released.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    # Give it time to spin without acquiring
    time.sleep(0.3)
    assert not acquired.is_set(), "should NOT have force-claimed a fresh lock"
    # Release foreign lock; worker should now grab it
    lock.unlink(missing_ok=True)
    t.join(timeout=2.0)
    assert acquired.is_set()
    assert released.is_set()


# ---------------------------------------------------------------------------
# Token-based unlink (R44-LIVE-C1)
# ---------------------------------------------------------------------------
def test_safe_release_does_not_unlink_foreign_token(tmp_path: Path):
    """If our token is no longer in the file, we MUST NOT unlink — another
    process may have force-claimed and is now holding it."""
    lock = tmp_path / "foreign.lock"
    lock.write_text("other-process-token-zzzzz")
    our_token = _make_token()
    # We don't own the file → release is a no-op
    _safe_release(lock, our_token)
    assert lock.exists()
    assert lock.read_text() == "other-process-token-zzzzz"


def test_safe_release_handles_missing_lock_file(tmp_path: Path):
    """If the lock file already disappeared, release silently no-ops."""
    lock = tmp_path / "ghost.lock"
    # File doesn't exist
    _safe_release(lock, _make_token())  # must not raise


def test_make_token_unique_per_call():
    a = _make_token()
    b = _make_token()
    assert a != b
    assert str(os.getpid()) in a
    assert str(os.getpid()) in b


# ---------------------------------------------------------------------------
# Re-entrant / sequential acquire works
# ---------------------------------------------------------------------------
def test_file_lock_can_be_reacquired_after_release(tmp_path: Path):
    lock = tmp_path / "reacq.lock"
    for _ in range(3):
        with file_lock(lock):
            assert lock.exists()
        assert not lock.exists()


# ---------------------------------------------------------------------------
# Concurrent threads contending for the same lock
# ---------------------------------------------------------------------------
def test_file_lock_serializes_concurrent_threads(tmp_path: Path):
    """Two threads acquiring the same lock must execute serially — at no
    point should both be in the critical section."""
    lock = tmp_path / "race.lock"
    in_section = []
    overlaps = []

    def worker(idx: int):
        with file_lock(lock, timeout_sec=2.0, stale_sec=300.0, backoff_sec=0.005):
            in_section.append(idx)
            if len(in_section) > 1:
                overlaps.append(list(in_section))
            time.sleep(0.05)
            in_section.remove(idx)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10.0)
    assert overlaps == [], f"overlapping critical sections: {overlaps}"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
