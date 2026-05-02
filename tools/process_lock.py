"""Cross-process file lock via O_CREAT|O_EXCL sentinel.

Phase 34 (Code-Quality Audit refactor): unifies the previously-duplicated
``_file_lock`` from ftmo_executor.py with the TS impl in
``src/utils/processLock.ts``. Both Python and Node use the same sentinel
filename convention (``<state-dir>/<resource>.lock``) so they mutex on
shared state files.

Behavior:
  1. Try ``os.open(lock_path, O_CREAT|O_EXCL|O_WRONLY)`` → succeeds iff no holder
  2. On FileExistsError: wait ``backoff_sec`` and retry
  3. After ``timeout_sec``: if lock-file mtime ≥ ``stale_sec`` old, force-claim
     (assume crashed holder); else keep waiting (no exception — Python callers
     prefer force-progress over fail-loud, matching the original ``_file_lock``)
  4. On exit: unlink lock-file

``stale_sec = 0`` (default) means "always recover after timeout" — preserves
the original behavior that was hardcoded into ``_file_lock``.
"""
import contextlib
import os
import time
from pathlib import Path
from typing import Iterator, Optional


@contextlib.contextmanager
def file_lock(
    lock_path: Path,
    timeout_sec: float = 2.0,
    stale_sec: float = 0.0,
    backoff_sec: float = 0.005,
) -> Iterator[None]:
    """Exclusive file lock via O_CREAT|O_EXCL sentinel.

    Args:
      lock_path: path to the sentinel file (parent dir auto-created)
      timeout_sec: max wait before triggering stale-recovery
      stale_sec: if lock-file mtime older than this, force-claim
                 (default 0 = always force-claim once timeout elapses,
                 matching the original ``_file_lock`` behavior)
      backoff_sec: sleep between attempts
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    fd: Optional[int] = None
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode())
            except Exception:
                pass
            break
        except FileExistsError:
            if time.time() - start > timeout_sec:
                try:
                    age = time.time() - lock_path.stat().st_mtime
                    if age >= stale_sec:
                        lock_path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue  # lock disappeared — retry
                # not stale yet, but timed out — keep backing off
            time.sleep(backoff_sec)
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass
