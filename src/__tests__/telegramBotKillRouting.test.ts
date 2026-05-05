/**
 * Round 60 (Audit Round 3, Task A): /kill multi-account routing.
 *
 * Verifies that `resolveKillTargets` discovers sibling state-dirs in the
 * project root and routes /kill commands correctly:
 *   - `/kill` (no arg)        → usage hint, no state-dir mutation
 *   - `/kill all`             → broadcast across every sibling
 *   - `/kill <accountId>`     → single sibling matched by suffix
 *   - `/kill <unknown>`       → not-found, no mutation
 *
 * Sibling discovery uses the parent of `currentStateDir` (typically the
 * project cwd). Tests build a temp directory tree to avoid touching real
 * project state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveKillTargets } from "../utils/telegramBot";

let testRoot: string;

function makeStateDir(parent: string, name: string, withFile = true): string {
  const abs = path.join(parent, name);
  fs.mkdirSync(abs, { recursive: true });
  if (withFile) {
    // Probe needs at least one entry to count the dir as a real state-dir.
    fs.writeFileSync(path.join(abs, "account.json"), "{}");
  }
  return abs;
}

describe("Telegram /kill multi-account routing (Round 60 Task A)", () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kill-routing-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("returns 'usage' when arg is empty (operator typed bare /kill)", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    const r = resolveKillTargets(cur, "");
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") {
      expect(r.available).toContain("ftmo-state-2h-trend-v5-r28-v6-demo1");
      expect(r.available).toContain("ftmo-state-2h-trend-v5-r28-v6-demo2");
      expect(r.thisAccount).toBe("2h-trend-v5-r28-v6-demo1");
    }
  });

  it("/kill all expands to every sibling state-dir", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo3");
    // Unrelated dir must NOT appear
    makeStateDir(testRoot, "node_modules");
    const r = resolveKillTargets(cur, "all");
    expect(r.kind).toBe("broadcast");
    if (r.kind === "broadcast") {
      expect(r.dirs.length).toBe(3);
      expect(r.dirs.map((d) => path.basename(d))).toEqual(
        expect.arrayContaining([
          "ftmo-state-2h-trend-v5-r28-v6-demo1",
          "ftmo-state-2h-trend-v5-r28-v6-demo2",
          "ftmo-state-2h-trend-v5-r28-v6-demo3",
        ]),
      );
      expect(r.dirs.map((d) => path.basename(d))).not.toContain("node_modules");
    }
  });

  it("/kill <suffix> matches a single sibling by trailing slug", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo3");
    const r = resolveKillTargets(cur, "demo2");
    expect(r.kind).toBe("single");
    if (r.kind === "single") {
      expect(r.dirs.length).toBe(1);
      expect(path.basename(r.dirs[0]!)).toBe(
        "ftmo-state-2h-trend-v5-r28-v6-demo2",
      );
    }
  });

  it("/kill <fullName> matches by exact dir basename", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    const r = resolveKillTargets(cur, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    expect(r.kind).toBe("single");
    if (r.kind === "single") {
      expect(r.dirs.length).toBe(1);
    }
  });

  it("/kill <unknown> returns not-found with available list", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo2");
    const r = resolveKillTargets(cur, "demo99");
    expect(r.kind).toBe("not-found");
    if (r.kind === "not-found") {
      expect(r.available.length).toBe(2);
    }
  });

  it("BACKWARD COMPAT: /kill all on single-account install hits exactly one dir", () => {
    // Legacy single-account: only the bot's own state-dir exists.
    const cur = makeStateDir(testRoot, "ftmo-state");
    const r = resolveKillTargets(cur, "all");
    expect(r.kind).toBe("broadcast");
    if (r.kind === "broadcast") {
      expect(r.dirs.length).toBe(1);
      expect(path.basename(r.dirs[0]!)).toBe("ftmo-state");
    }
  });

  it("ignores empty state-dir skeletons (no probe files)", () => {
    const cur = makeStateDir(testRoot, "ftmo-state-2h-trend-v5-r28-v6-demo1");
    // Skeleton dir with matching name but no contents → must be ignored.
    fs.mkdirSync(path.join(testRoot, "ftmo-state-empty"));
    const r = resolveKillTargets(cur, "all");
    expect(r.kind).toBe("broadcast");
    if (r.kind === "broadcast") {
      expect(r.dirs.map((d) => path.basename(d))).not.toContain(
        "ftmo-state-empty",
      );
    }
  });
});
