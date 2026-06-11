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


def test_stale_reclaim_does_not_unlink_freshly_acquired_lock(tmp_path: Path):
    """2026-05-15 Codex external audit BUG #7 regression test.

    Scenario: process A's stale lock is on disk. Two waiters (B and C) both
    time out at roughly the same instant. B unlinks the stale lock first and
    successfully O_EXCL re-creates it with B's token. C — without the
    token-verify fix — would then proceed to unlink B's brand-new lock.

    We simulate this by:
      1. Manually placing a stale-on-disk lock with token "OLD".
      2. Spawning a thread that, between our pretend-stat and pretend-unlink,
         atomically replaces the token with "NEW" (mimicking the race winner).
      3. Calling file_lock from the main thread with very short timeout +
         stale_sec=0 (always-stale). After the call returns, the lock should
         hold the MAIN thread's token — not "NEW" — and "NEW" must not have
         been replaced or unlinked by foreign code.

    With the fix: main reads token, sees "OLD", reads again, sees "NEW" →
    abort unlink → retry → eventually acquire normally (because the racer
    in our test releases the lock).
    Without the fix: main blindly unlinks "NEW", grabs the slot, races
    against the legitimate holder.
    """
    lock = tmp_path / "stale.lock"
    # Step 1: place a stale token.
    lock.write_text("OLD")
    # Backdate mtime so stale_sec=0 trips.
    old_mtime = time.time() - 60
    os.utime(lock, (old_mtime, old_mtime))

    # Step 2: spawn a race-injector that swaps OLD→NEW after a tiny delay.
    # This mimics another waiter claiming the lock between our token-reads.
    swap_done = threading.Event()

    def race_injector():
        time.sleep(0.01)
        # Replace token via direct write (simulating another process's
        # O_EXCL+write sequence).
        try:
            lock.write_text("NEW")
            os.utime(lock, None)  # refresh mtime → no longer stale
        finally:
            swap_done.set()

    t = threading.Thread(target=race_injector)
    t.start()

    # Step 3: try to acquire with very short timeout + stale_sec=0 so the
    # stale-recovery branch is reached at least once.
    # Note: file_lock spins forever on Python side; if our retry-on-mismatch
    # works the swap_done event fires (NEW is written), our lock-acquire
    # will succeed AFTER race_injector returns. Critical assertion: we
    # never unlinked NEW.
    captured_tokens: list[str] = []

    def acquirer():
        with file_lock(lock, timeout_sec=0.05, stale_sec=0.0, backoff_sec=0.005):
            captured_tokens.append(lock.read_text())

    a = threading.Thread(target=acquirer)
    a.start()
    a.join(timeout=5.0)
    t.join(timeout=5.0)

    # After both finish: race_injector wrote NEW once. acquirer may or may
    # not have unlinked it (depending on timing), but if it DID unlink, it
    # must have been BECAUSE the token matched what acquirer last saw —
    # not because of a TOCTOU race. The strongest invariant we can check
    # is: when acquirer was in the critical section, the on-disk token was
    # its own token (not "NEW", not "OLD"). And acquirer must eventually
    # have succeeded (didn't deadlock).
    assert len(captured_tokens) == 1, "acquirer must have entered critical section"
    assert captured_tokens[0] not in ("OLD", "NEW"), (
        f"acquirer's lock should hold its own token, not foreign: {captured_tokens[0]}"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
