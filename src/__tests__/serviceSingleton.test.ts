/**
 * Round 60 (Audit Round 3, Task B): per-state-dir singleton lock for
 * ftmoLiveService.ts. Mirrors Python's `acquire_singleton_or_exit()`
 * pattern in tools/ftmo_executor.py:2965.
 *
 * Tests cover:
 *   - cold start (no PID file) acquires successfully
 *   - second launch with live peer is refused
 *   - stale PID (dead peer) is taken over
 *   - own PID in the file is treated as a re-acquire (idempotent)
 *   - corrupt PID file is treated as stale
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireSingletonLock,
  SINGLETON_PID_FILE,
} from "../utils/serviceSingleton";

let testRoot: string;

describe("serviceSingleton (Round 60 Task B)", () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-singleton-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("cold start: acquires successfully and writes our PID", () => {
    const stateDir = path.join(testRoot, "ftmo-state-test");
    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(true);
    const written = fs.readFileSync(
      path.join(stateDir, SINGLETON_PID_FILE),
      "utf-8",
    );
    expect(parseInt(written, 10)).toBe(process.pid);
  });

  it("refuses to start when peer PID is alive", () => {
    const stateDir = path.join(testRoot, "ftmo-state-test");
    fs.mkdirSync(stateDir, { recursive: true });
    // Use the test process's parent PID (or 1, init, on Linux) — guaranteed
    // alive but != process.pid. Fall back to 1 if ppid resolves to 0.
    const livePid =
      process.ppid && process.ppid !== process.pid ? process.ppid : 1;
    fs.writeFileSync(path.join(stateDir, SINGLETON_PID_FILE), String(livePid));

    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(false);
    expect(r.otherPid).toBe(livePid);
    expect(r.reason).toContain(`pid=${livePid}`);
    // Original PID file must remain untouched
    const after = fs.readFileSync(
      path.join(stateDir, SINGLETON_PID_FILE),
      "utf-8",
    );
    expect(parseInt(after, 10)).toBe(livePid);
  });

  it("takes over a stale PID (dead peer)", () => {
    const stateDir = path.join(testRoot, "ftmo-state-test");
    fs.mkdirSync(stateDir, { recursive: true });
    // PID 99999999 is virtually guaranteed not to exist
    const stalePid = 99_999_999;
    fs.writeFileSync(path.join(stateDir, SINGLETON_PID_FILE), String(stalePid));

    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(true);
    const written = fs.readFileSync(
      path.join(stateDir, SINGLETON_PID_FILE),
      "utf-8",
    );
    expect(parseInt(written, 10)).toBe(process.pid);
  });

  it("treats corrupt/empty PID file as stale", () => {
    const stateDir = path.join(testRoot, "ftmo-state-test");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, SINGLETON_PID_FILE), "not-a-number\n");
    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(true);
  });

  it("idempotent: own PID in the file is a no-conflict acquire", () => {
    const stateDir = path.join(testRoot, "ftmo-state-test");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, SINGLETON_PID_FILE),
      String(process.pid),
    );
    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(true);
  });

  it("creates state dir if it doesn't exist", () => {
    const stateDir = path.join(testRoot, "deep", "nested", "ftmo-state-test");
    expect(fs.existsSync(stateDir)).toBe(false);
    const r = acquireSingletonLock(stateDir);
    expect(r.acquired).toBe(true);
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it("two sibling state-dirs both acquire (per-state-dir scoping)", () => {
    // Per-state-dir lock means demo1 and demo2 both succeed even within the
    // same Node process — the lock is keyed by directory, not by token.
    const dir1 = path.join(testRoot, "ftmo-state-demo1");
    const dir2 = path.join(testRoot, "ftmo-state-demo2");
    const r1 = acquireSingletonLock(dir1);
    const r2 = acquireSingletonLock(dir2);
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(true);
  });
});
