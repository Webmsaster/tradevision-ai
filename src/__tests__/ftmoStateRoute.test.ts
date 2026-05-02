/**
 * Test the /api/ftmo-state route reads state files correctly.
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
import * as path from "node:path";
import * as os from "node:os";

const testStateDir = path.join(os.tmpdir(), `ftmo-state-test-${Date.now()}`);

beforeAll(() => {
  fs.mkdirSync(testStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(testStateDir, "account.json"),
    JSON.stringify({
      equity: 1.05,
      day: 5,
      raw_equity_usd: 105000,
    }),
  );
  fs.writeFileSync(
    path.join(testStateDir, "open-positions.json"),
    JSON.stringify({
      positions: [
        { ticket: 123, signalAsset: "ETH-MR", lot: 0.5, entry_price: 2400 },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(testStateDir, "bot-controls.json"),
    JSON.stringify({ paused: true }),
  );
  process.env.FTMO_STATE_DIR = testStateDir;
  process.env.FTMO_MONITOR_ENABLED = "1";
});

afterAll(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  delete process.env.FTMO_STATE_DIR;
  delete process.env.FTMO_MONITOR_ENABLED;
});

describe("/api/ftmo-state route", () => {
  // Phase 63 (R45-TEST-5): reset the module cache between tests so each
  // `await import("@/app/api/ftmo-state/route")` re-evaluates the module
  // against the CURRENT env. Without this, a route module that read env
  // at import-time would see stale FTMO_STATE_DIR / FTMO_MONITOR_ENABLED
  // values from the first test run.
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns bundled state JSON", async () => {
    // Re-import so the route module picks up FTMO_STATE_DIR from env
    const { GET } = await import("@/app/api/ftmo-state/route");
    const resp = await GET();
    const body = await resp.json();

    expect(body.account.equity).toBe(1.05);
    expect(body.account.day).toBe(5);
    expect(body.openPos.positions).toHaveLength(1);
    expect(body.openPos.positions[0].ticket).toBe(123);
    expect(body.controls.paused).toBe(true);
    // Phase 33 (API Audit Bug 5): stateDir is now relative to cwd
    // (information-disclosure fix — no absolute server paths).
    expect(body.stateDir).toBe(path.relative(process.cwd(), testStateDir));
    expect(body.generatedAt).toBeDefined();
  });

  it("returns defaults when files missing", async () => {
    const emptyDir = path.join(os.tmpdir(), `ftmo-empty-${Date.now()}`);
    fs.mkdirSync(emptyDir);
    process.env.FTMO_STATE_DIR = emptyDir;

    const { GET } = await import("@/app/api/ftmo-state/route");
    const resp = await GET();
    const body = await resp.json();

    // Defaults should be present
    expect(body.account).toEqual({});
    expect(body.openPos.positions).toEqual([]);
    expect(body.pending.signals).toEqual([]);

    fs.rmSync(emptyDir, { recursive: true, force: true });
    process.env.FTMO_STATE_DIR = testStateDir;
  });

  it("returns 404 when FTMO_MONITOR_ENABLED is unset (production safety)", async () => {
    delete process.env.FTMO_MONITOR_ENABLED;

    const { GET } = await import("@/app/api/ftmo-state/route");
    const resp = await GET();

    expect(resp.status).toBe(404);

    // Re-enable for subsequent tests
    process.env.FTMO_MONITOR_ENABLED = "1";
  });
});
