/**
 * Cross-process file lock via O_CREAT|O_EXCL sentinel.
 *
 * Phase 34 (Code-Quality Audit refactor): unifies three previously-duplicated
 * implementations (`withFileLock` in scripts/ftmoLiveService.ts,
 * `withControlsLock` in src/utils/telegramBot.ts, `_file_lock` in
 * tools/ftmo_executor.py). Mirror Python impl: tools/process_lock.py.
 *
 * Phase 38 (R44-LIVE-C1/C2): token-based unlink — without a token check,
 * a long-running holder whose lock got stale-claimed by another process
 * would unlink THEIR fresh lock on its way out, leaving two simultaneous
 * holders. We now write `pid:randomToken` at acquire time and verify the
 * token matches before unlink. Mismatch = our lock was stolen — leave the
 * new holder alone.
 *
 * Both async and sync variants are exposed because the bot stack mixes
 * async pollers (signal service) with sync handlers (Telegram callback
 * dispatch). Lock semantics:
 *   1. Try `openSync(lockPath, "wx")` → succeeds iff no holder
 *   2. Write `pid:token` to claim
 *   3. On EEXIST: wait `backoffMs` and retry
 *   4. After `timeoutMs`: if lock-file mtime ≥ `staleMs` old, force-claim
 *      (assume crashed holder); else throw timeout error
 *   5. On exit: read lock-file, unlink ONLY if our token still owns it
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
   * force-claim it (assume crashed holder). Default 30000ms (async) /
   * 5000ms (sync). Set to 0 for unconditional force-claim after timeout.
   */
  staleMs?: number;
  /** Backoff between acquisition attempts. */
  backoffMs?: number;
}

const DEFAULT_ASYNC_OPTS = { timeoutMs: 5000, staleMs: 30_000, backoffMs: 50 };
// Phase 38 (R44-LIVE-M3): default staleMs raised from 0 → 5000 so callers
// that don't opt into force-progress don't unconditionally claim foreign
// locks after their (small) timeout. Telegram bot still passes staleMs:0
// explicitly via withControlsLock.
const DEFAULT_SYNC_OPTS = { timeoutMs: 2000, staleMs: 5000, backoffMs: 5 };

function makeToken(): string {
  // Cheap unique-enough token: pid + millis + random.
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function safeReleaseLock(lockPath: string, ourToken: string): void {
  try {
    const held = fs.readFileSync(lockPath, "utf-8");
    if (held === ourToken) {
      fs.unlinkSync(lockPath);
    }
    // else: another process force-claimed our lock — leave their token alone.
  } catch {
    /* lock-file already gone — nothing to release */
  }
}

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
  const ourToken = makeToken();
  let fd!: number; // assigned in the only break-out path below
  while (true) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, ourToken);
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
        throw new Error(`withFileLock: timeout acquiring ${lockPath}`, {
          cause: e,
        });
      }
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    safeReleaseLock(lockPath, ourToken);
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
  const ourToken = makeToken();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, ourToken);
      } finally {
        fs.closeSync(fd);
      }
      try {
        return fn();
      } finally {
        safeReleaseLock(lockPath, ourToken);
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
        throw new Error(`withFileLockSync: timeout acquiring ${lockPath}`, {
          cause: e,
        });
      }
      // Sync busy-spin (caller is sync — no async wait possible).
      const until = Date.now() + backoffMs;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
