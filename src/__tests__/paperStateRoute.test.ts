/**
 * Round 54 (Finding #1): /api/paper-state must not echo node:fs error
 * messages back to the client. Without this guard, a corrupt JSON file
 * (or any other read failure) leaks the absolute server path
 * (`/home/<user>/.tradevision-ai/...`) — information disclosure
 * (CWE-209).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fakeHome = path.join(os.tmpdir(), `paper-state-test-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(path.join(fakeHome, ".tradevision-ai"), { recursive: true });
  // Inject a CORRUPT json so JSON.parse throws.
  fs.writeFileSync(
    path.join(fakeHome, ".tradevision-ai", "paper-trades.json"),
    "{ this is not valid json",
  );
  // Override homedir() by setting HOME env-var (node:os respects this on
  // POSIX); also set USERPROFILE for Windows test runners.
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.FTMO_MONITOR_ENABLED = "1";
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.FTMO_MONITOR_ENABLED;
});

describe("/api/paper-state error sanitization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not leak absolute paths or username on parse failure", async () => {
    const { GET } = await import("@/app/api/paper-state/route");
    const resp = await GET();
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe("Internal error");
    // Critical: error string must not contain a filesystem path or the
    // tmpdir-username we set up. The previous (vulnerable) code echoed
    // `(err as Error).message` which on a real ENOENT would include the
    // absolute path.
    const errStr = JSON.stringify(body);
    expect(errStr).not.toContain(fakeHome);
    expect(errStr).not.toContain(".tradevision-ai");
    expect(errStr).not.toContain(os.homedir());
    expect(errStr).not.toMatch(/ENOENT|EACCES|SyntaxError/i);
    // Defaults still surfaced so client UI degrades gracefully.
    expect(body.openPositions).toEqual([]);
    expect(body.closedTrades).toEqual([]);
  });

  it("returns 404 when FTMO_MONITOR_ENABLED is unset", async () => {
    delete process.env.FTMO_MONITOR_ENABLED;
    const { GET } = await import("@/app/api/paper-state/route");
    const resp = await GET();
    expect(resp.status).toBe(404);
    process.env.FTMO_MONITOR_ENABLED = "1";
  });
});
