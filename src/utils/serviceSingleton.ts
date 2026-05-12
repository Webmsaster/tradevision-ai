/**
 * Per-state-dir singleton lock for the Node signal service.
 *
 * Round 60 (Audit Round 3, Task B): mirror Python's
 * `acquire_singleton_or_exit()` (tools/ftmo_executor.py:2965). Two PM2
 * launches with identical FTMO_STATE_DIR would otherwise both poll Binance,
 * both serialise on pending-signals.lock (lock-protected) AND both start the
 * Telegram long-poll → 409 Conflict on `getUpdates` if MASTER=1 on both.
 *
 * Pattern:
 *   1. mkdir state-dir (idempotent)
 *   2. read existing PID file (if any)
 *   3. probe liveness via `process.kill(pid, 0)`
 *   4. alive → return { acquired: false, reason } so caller can exit(11)
 *   5. dead/missing → write our PID; register cleanup hooks
 *
 * Lives in src/utils/ (not scripts/) so it can be unit-tested without
 * triggering the side-effects of importing scripts/ftmoLiveService.ts
 * (which calls `main()` at module load time).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const SINGLETON_PID_FILE = "signal-service.pid";

export interface AcquireResult {
  acquired: boolean;
  /** PID of the running peer when `acquired === false`. */
  otherPid?: number;
  /** Human-readable reason, suitable for logs. */
  reason?: string;
}

/**
 * Try to acquire the per-state-dir singleton lock for the signal service.
 *
 * On success: writes our PID into `<stateDir>/signal-service.pid`, registers
 * exit/SIGTERM/SIGINT cleanup hooks, returns `{ acquired: true }`.
 *
 * On contention (peer alive): returns `{ acquired: false, otherPid }` —
 * caller is responsible for exiting (we don't `process.exit()` here so
 * tests can assert without crashing the test runner).
 *
 * Stale PID (process dead OR signal-0 returns ESRCH) is silently taken over.
 */
export function acquireSingletonLock(stateDir: string): AcquireResult {
  fs.mkdirSync(stateDir, { recursive: true });
  const pidFile = path.join(stateDir, SINGLETON_PID_FILE);
  if (fs.existsSync(pidFile)) {
    let otherPid = 0;
    try {
      otherPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10) || 0;
    } catch {
      otherPid = 0;
    }
    if (otherPid > 0 && otherPid !== process.pid) {
      let alive = false;
      try {
        // Signal 0 doesn't deliver — only checks permission/existence.
        process.kill(otherPid, 0);
        alive = true;
      } catch (e) {
        // ESRCH = no such process; EPERM = exists but not ours (still alive).
        const code = (e as NodeJS.ErrnoException).code;
        alive = code === "EPERM";
      }
      if (alive) {
        return {
          acquired: false,
          otherPid,
          reason: `another signal service is already running (pid=${otherPid}, state_dir=${stateDir})`,
        };
      }
    }
  }
  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch (e) {
    // Best-effort: read-only FS / permission edge cases. Match Python.
    return {
      acquired: true,
      reason: `pid file write failed: ${(e as Error).message}`,
    };
  }
  registerCleanup(pidFile);
  return { acquired: true };
}

/**
 * Process-exit / signal cleanup. Only unlinks the file if it still holds
 * OUR PID — protects against a foreign process taking the slot after we
 * died and leaving us with a fresh "stale" file to clobber.
 */
function registerCleanup(pidFile: string): void {
  const cleanup = () => {
    try {
      const held = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10) || 0;
      if (held === process.pid) fs.unlinkSync(pidFile);
    } catch {
      /* best-effort */
    }
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}
