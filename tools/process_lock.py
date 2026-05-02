"""Cross-process file lock via O_CREAT|O_EXCL sentinel.

Phase 34 (Code-Quality Audit refactor): unifies the previously-duplicated
``_file_lock`` from ftmo_executor.py with the TS impl in
``src/utils/processLock.ts``. Both Python and Node use the same sentinel
filename convention (``<state-dir>/<resource>.lock``) so they mutex on
shared state files.

Phase 38 (R44-LIVE-C1): token-based unlink — without a token check, a
long-running holder whose lock got stale-claimed by another process would
unlink THEIR fresh lock on its way out. We now write ``pid:randomToken``
at acquire time and verify the token still matches before unlink.

Behavior:
  1. Try ``os.open(lock_path, O_CREAT|O_EXCL|O_WRONLY)`` → succeeds iff no holder
  2. Write ``pid:token`` to claim
  3. On FileExistsError: wait ``backoff_sec`` and retry
  4. After ``timeout_sec``: if lock-file mtime ≥ ``stale_sec`` old, force-claim
     (assume crashed holder); else keep waiting (no exception — Python callers
     prefer force-progress over fail-loud, matching the original ``_file_lock``)
  5. On exit: read lock-file, unlink ONLY if our token still owns it

``stale_sec = 0`` means "always recover after timeout". Default raised to
30s for parity with Node-side ``DEFAULT_ASYNC_OPTS.staleMs`` so future
shared resources don't accidentally race each other.
"""
import contextlib
import os
import secrets
import time
from pathlib import Path
from typing import Iterator, Optional


def _make_token() -> str:
    return f"{os.getpid()}:{int(time.time() * 1000)}:{secrets.token_hex(4)}"


def _safe_release(lock_path: Path, our_token: str) -> None:
    try:
        held = lock_path.read_text()
    except FileNotFoundError:
        return
    except Exception:
        return
    if held == our_token:
        try:
            lock_path.unlink(missing_ok=True)
        except Exception:
            pass


@contextlib.contextmanager
def file_lock(
    lock_path: Path,
    timeout_sec: float = 2.0,
    stale_sec: float = 30.0,
    backoff_sec: float = 0.005,
) -> Iterator[None]:
    """Exclusive file lock via O_CREAT|O_EXCL sentinel.

    Args:
      lock_path: path to the sentinel file (parent dir auto-created)
      timeout_sec: max wait before triggering stale-recovery
      stale_sec: if lock-file mtime older than this, force-claim. Default
                 30s matches Node ``DEFAULT_ASYNC_OPTS.staleMs``. Pass 0
                 for "always force-claim after timeout" (matches the
                 original ``_file_lock`` behavior — used by callers that
                 prefer fail-progress over fail-loud).
      backoff_sec: sleep between attempts
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    our_token = _make_token()
    fd: Optional[int] = None
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, our_token.encode())
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
        _safe_release(lock_path, our_token)
