/**
 * Cross-process file lock via O_CREAT|O_EXCL sentinel.
 *
 * Phase 34 (Code-Quality Audit refactor): unifies three previously-duplicated
 * implementations (`withFileLock` in scripts/ftmoLiveService.ts,
 * `withControlsLock` in src/utils/telegramBot.ts, `_file_lock` in
 * tools/ftmo_executor.py). Mirror Python impl: tools/process_lock.py.
 *
 * Both async and sync variants are exposed because the bot stack mixes
 * async pollers (signal service) with sync handlers (Telegram callback
 * dispatch). The lock semantics are identical:
 *   1. Try `openSync(lockPath, "wx")` → succeeds iff no holder
 *   2. On EEXIST: wait `backoffMs` and retry
 *   3. After `timeoutMs`: if lock-file mtime ≥ `staleMs` old, force-claim
 *      (assume crashed holder); else throw timeout error
 *   4. On exit: unlink lock-file
 *
 * `staleMs = 0` means "always recover after timeout" — used by callers
 * that prefer "force-progress over fail-loud" (e.g. Telegram bot, where
 * blocking on a stale lock would freeze the user-facing chat).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileLockOptions {
  /** Max time to wait for the lock before triggering stale-recovery. */
  timeoutMs?: number;
  /**
   * If the lock file's mtime is older than this when timeout fires,
   * force-claim it (assume crashed holder). Default 30000ms.
   * Set to 0 for unconditional force-claim after timeout.
   */
  staleMs?: number;
  /** Backoff between acquisition attempts. */
  backoffMs?: number;
}

const DEFAULT_ASYNC_OPTS = { timeoutMs: 5000, staleMs: 30_000, backoffMs: 50 };
const DEFAULT_SYNC_OPTS = { timeoutMs: 2000, staleMs: 0, backoffMs: 5 };

export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ASYNC_OPTS.timeoutMs;
  const staleMs = opts.staleMs ?? DEFAULT_ASYNC_OPTS.staleMs;
  const backoffMs = opts.backoffMs ?? DEFAULT_ASYNC_OPTS.backoffMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd: number | null = null;
  while (true) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs >= staleMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* lock disappeared — retry */
          continue;
        }
        throw new Error(`withFileLock: timeout acquiring ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_OPTS.timeoutMs;
  const staleMs = opts.staleMs ?? DEFAULT_SYNC_OPTS.staleMs;
  const backoffMs = opts.backoffMs ?? DEFAULT_SYNC_OPTS.backoffMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  while (true) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs >= staleMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* lock disappeared — retry */
          continue;
        }
        throw new Error(`withFileLockSync: timeout acquiring ${lockPath}`);
      }
      // Sync busy-spin (caller is sync — no async wait possible).
      const until = Date.now() + backoffMs;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
