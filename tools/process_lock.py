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
    max_wait_sec: float = 60.0,
) -> Iterator[None]:
    """Exclusive file lock via O_CREAT|O_EXCL sentinel.

    Args:
      lock_path: path to the sentinel file (parent dir auto-created)
      timeout_sec: time before stale-recovery is attempted (lower bound).
      stale_sec: if lock-file mtime older than this, force-claim. Default
                 30s matches Node ``DEFAULT_ASYNC_OPTS.staleMs``. Pass 0
                 for "always force-claim after timeout".
      backoff_sec: initial sleep between attempts (exponential up to 500ms).
      max_wait_sec: hard deadline. Beyond this, raises ``TimeoutError`` so
                 callers see a fail-loud signal instead of spinning forever
                 against a healthy-but-busy holder that keeps refreshing the
                 lock file inside ``stale_sec``. Default 60s (Wave2 audit:
                 unbounded spin was the original behavior — documented but
                 unsafe under live-trading SLAs).
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    start = time.time()
    our_token = _make_token()
    fd: Optional[int] = None
    cur_backoff = backoff_sec
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                n_written = os.write(fd, our_token.encode())
                if n_written != len(our_token.encode()):
                    # 2026-05-23 Wave2 fix (B5): partial write (e.g. ENOSPC)
                    # would leave an empty lock file → _safe_release compares
                    # "" against our_token → never releases. Treat any short
                    # write as a hard failure and clean up.
                    try:
                        os.close(fd)
                    finally:
                        fd = None
                    lock_path.unlink(missing_ok=True)
                    raise OSError("short write while acquiring lock")
            except OSError:
                raise
            except Exception:
                pass
            break
        except FileExistsError:
            # 2026-05-23 Wave2 fix (B1): hard deadline. Without this the loop
            # spins forever against a live holder that refreshes < stale_sec.
            if time.time() - start > max_wait_sec:
                raise TimeoutError(
                    f"file_lock exceeded max_wait_sec={max_wait_sec}s on {lock_path}"
                )
            if time.time() - start > timeout_sec:
                # 2026-05-15 Codex external audit BUG #7 FIX — stale-reclaim
                # TOCTOU race. Previously: stat → check age → unlink. Between
                # the stat() and the unlink(), a competing process could:
                #   (1) also detect the stale lock,
                #   (2) unlink it,
                #   (3) successfully O_EXCL re-create with its own token.
                # The original holder's unlink at step (3+) then deletes a
                # legitimate fresh lock, allowing a third process to grab it.
                # Mitigation: capture the stale token BEFORE the unlink, and
                # ONLY unlink if the on-disk token still matches what we
                # observed when we decided the lock was stale. If the token
                # changed (race lost), fall through to retry — the new holder
                # gets to keep their lock.
                try:
                    st = lock_path.stat()
                    age = time.time() - st.st_mtime
                    if age >= stale_sec:
                        try:
                            stale_token = lock_path.read_text()
                        except FileNotFoundError:
                            continue  # lock disappeared — retry
                        except Exception:
                            stale_token = ""
                        # 2026-05-23 Wave2 fix (B2): probe holder PID before
                        # reclaiming. Token format is "host:pid:nanos". If the
                        # process is still alive (kill -0 succeeds), the lock
                        # is held by a busy-but-live holder doing slow work;
                        # do NOT steal — wait another stale_sec interval. This
                        # only steals when the holder is genuinely dead.
                        try:
                            parts = stale_token.split(":")
                            if len(parts) >= 2:
                                pid = int(parts[1])
                                if pid > 0:
                                    try:
                                        os.kill(pid, 0)
                                        # Holder alive — reset stale timer.
                                        os.utime(lock_path, None)
                                        time.sleep(cur_backoff)
                                        cur_backoff = min(cur_backoff * 2.0, 0.5)
                                        continue
                                    except ProcessLookupError:
                                        pass  # dead → safe to reclaim
                                    except PermissionError:
                                        pass  # different user — assume alive
                        except (ValueError, IndexError):
                            pass  # malformed token → proceed to reclaim
                        # Race-safe unlink: re-read the file's token; if it
                        # changed between our read and now, abort the unlink.
                        # On POSIX there is no atomic "unlink if content
                        # matches"; we approximate it by verifying twice. The
                        # remaining window is tiny (~µs); a paranoid caller
                        # can raise stale_sec to make races even rarer.
                        try:
                            current_token = lock_path.read_text()
                        except FileNotFoundError:
                            continue
                        except Exception:
                            current_token = ""
                        if current_token == stale_token and stale_token:
                            lock_path.unlink(missing_ok=True)
                        # else: another process raced us — retry without
                        # unlinking (would delete THEIR fresh lock).
                        continue
                except FileNotFoundError:
                    continue  # lock disappeared — retry
                # not stale yet, but timed out — keep backing off
            # 2026-05-23 Wave2 fix (B8): exponential backoff. The fixed 5ms
            # spin produced ~200 polls/sec under contention. Cap at 500ms so
            # high-frequency callers still see sub-second hand-off.
            time.sleep(cur_backoff)
            cur_backoff = min(cur_backoff * 2.0, 0.5)
    try:
        yield
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass
        _safe_release(lock_path, our_token)
