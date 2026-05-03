/**
 * Test the /api/drift-data route reads + derives FTMO bot state correctly.
 *
 * Covers:
 *  - 404 when FTMO_MONITOR_ENABLED unset (production safety)
 *  - happy path: equity, drift vs backtest, daily bars, positions, health
 *  - missing files → safe defaults
 *  - ftmo_tf slug whitelist rejects path-traversal attempts
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
import { NextRequest } from "next/server";

const testStateDir = path.join(os.tmpdir(), `ftmo-drift-test-${Date.now()}`);

function makeReq(qs = ""): NextRequest {
  const url = `http://localhost/api/drift-data${qs}`;
  return new NextRequest(url);
}

beforeAll(() => {
  fs.mkdirSync(testStateDir, { recursive: true });

  // Account: live equity 102.5k after a few days
  fs.writeFileSync(
    path.join(testStateDir, "account.json"),
    JSON.stringify({
      equity: 1.025,
      day: 3,
      raw_equity_usd: 102_500,
      equityAtDayStart: 1.015,
      updated_at: "2026-04-26T18:00:00Z",
    }),
  );

  // Daily-reset (today's anchor)
  fs.writeFileSync(
    path.join(testStateDir, "daily-reset.json"),
    JSON.stringify({
      date: "2026-04-26",
      equity_at_day_start_usd: 101_500,
      snapped_at: "2026-04-26T08:00:00Z",
    }),
  );

  // Peak-state
  fs.writeFileSync(
    path.join(testStateDir, "peak-state.json"),
    JSON.stringify({
      peak_equity: 103_000,
      peak_at: "2026-04-26T12:00:00Z",
    }),
  );

  // Open positions
  fs.writeFileSync(
    path.join(testStateDir, "open-positions.json"),
    JSON.stringify({
      positions: [
        {
          ticket: 1001,
          signalAsset: "BTC-MR",
          sourceSymbol: "BTCUSDT",
          direction: "long",
          lot: 0.05,
          entry_price: 70_000,
          stop_price: 68_500,
          tp_price: 72_000,
          opened_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          max_hold_until: Date.now() + 4 * 3600_000,
        },
      ],
    }),
  );

  // Bot controls
  fs.writeFileSync(
    path.join(testStateDir, "bot-controls.json"),
    JSON.stringify({ paused: false, killRequested: false }),
  );

  // Pending signals
  fs.writeFileSync(
    path.join(testStateDir, "pending-signals.json"),
    JSON.stringify({ signals: [] }),
  );

  // Executor log: a few daily anchors over consecutive days + recent fresh log
  const now = new Date();
  const log = [
    {
      ts: "2026-04-23T10:00:00Z",
      event: "daily_state_first_write",
      date: "2026-04-23",
      equity: 100_000,
    },
    {
      ts: "2026-04-24T08:00:00Z",
      event: "daily_state_first_write",
      date: "2026-04-24",
      equity: 100_800,
    },
    {
      ts: "2026-04-25T08:00:00Z",
      event: "daily_state_first_write",
      date: "2026-04-25",
      equity: 101_300,
    },
    {
      ts: "2026-04-26T08:00:00Z",
      event: "daily_state_first_write",
      date: "2026-04-26",
      equity: 101_500,
    },
    {
      ts: new Date(now.getTime() - 60_000).toISOString(),
      event: "signal_check",
      signalCount: 0,
    },
    {
      ts: new Date(now.getTime() - 30_000).toISOString(),
      event: "news_blackout_skip",
      reason: "FOMC",
    },
  ];
  fs.writeFileSync(
    path.join(testStateDir, "executor-log.jsonl"),
    log.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  process.env.FTMO_STATE_DIR = testStateDir;
  process.env.FTMO_MONITOR_ENABLED = "1";
  process.env.FTMO_START_BALANCE = "100000";
});

afterAll(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
  delete process.env.FTMO_STATE_DIR;
  delete process.env.FTMO_MONITOR_ENABLED;
  delete process.env.FTMO_START_BALANCE;
});

describe("/api/drift-data route", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FTMO_MONITOR_ENABLED = "1";
    process.env.FTMO_STATE_DIR = testStateDir;
  });

  it("returns full drift payload from the configured state dir", async () => {
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq());
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // Header
    expect(body.header.passStatus).toBe("active");
    expect(body.header.daysElapsed).toBe(3);
    expect(body.header.daysRemaining).toBe(27);

    // Equity
    expect(body.equity.currentUsd).toBe(102_500);
    expect(body.equity.totalPnlPct).toBeCloseTo(2.5, 2);
    expect(body.equity.peakUsd).toBe(103_000);

    // Drift: live +2.5% on day 3, R28_V5 median at day 3 = (10/4)*3 = 7.5%
    // → drift = 2.5 - 7.5 = -5.0 (slightly underperforming)
    expect(body.drift).not.toBeNull();
    expect(body.drift.driftPct).toBeCloseTo(-5.0, 1);

    // Backtest band: 31 entries (day 0..30)
    expect(body.backtestBand).toHaveLength(31);
    expect(body.backtestBand[0].median).toBe(0);
    expect(body.backtestBand[4].median).toBeCloseTo(10, 5);

    // Daily PnL bars: 4 anchors → 4 bars
    expect(body.dailyPnlBars.length).toBe(4);

    // Positions annotated with ageMin
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0].signalAsset).toBe("BTC-MR");
    expect(body.positions[0].ageMin).toBeGreaterThan(0);

    // Health: heartbeat fresh because last log entry is 30s ago
    expect(body.health.botHeartbeatOk).toBe(true);
    expect(body.health.signalFeedFresh).toBe(true);

    // News markers
    expect(body.newsMarkers.length).toBeGreaterThan(0);
    expect(body.newsMarkers[0].label).toBe("FOMC");

    // Recent events (newest-first)
    expect(body.recentEvents.length).toBeGreaterThan(0);
    expect(body.recentEvents[0].event).toBe("news_blackout_skip");

    // Meta
    expect(body.meta.backtestRef.name).toBe("R28_V5");
    expect(body.meta.backtestRef.passRatePct).toBe(58.82);
  });

  it("flags pass status as 'passed' when total P&L ≥ +10%", async () => {
    fs.writeFileSync(
      path.join(testStateDir, "account.json"),
      JSON.stringify({
        equity: 1.105,
        day: 5,
        raw_equity_usd: 110_500,
      }),
    );
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq());
    const body = await resp.json();
    expect(body.header.passStatus).toBe("passed");

    // Restore for other tests
    fs.writeFileSync(
      path.join(testStateDir, "account.json"),
      JSON.stringify({
        equity: 1.025,
        day: 3,
        raw_equity_usd: 102_500,
        equityAtDayStart: 1.015,
        updated_at: "2026-04-26T18:00:00Z",
      }),
    );
  });

  it("returns 404 when FTMO_MONITOR_ENABLED is unset", async () => {
    delete process.env.FTMO_MONITOR_ENABLED;
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq());
    expect(resp.status).toBe(404);
  });

  it("rejects ftmo_tf slugs with invalid characters (path-traversal guard)", async () => {
    const { GET } = await import("@/app/api/drift-data/route");
    const bad = ["../etc", "foo/bar", "FOO", "x".repeat(80), "..", ""];
    for (const slug of bad) {
      const resp = await GET(makeReq(`?ftmo_tf=${encodeURIComponent(slug)}`));
      // Empty slug falls through to default state-dir (200 OK)
      if (slug === "") {
        expect(resp.status).toBe(200);
      } else {
        expect(resp.status).toBe(400);
      }
    }
  });

  it("accepts a valid ftmo_tf slug and reports it back in meta", async () => {
    // Use a slug that resolves to a (likely non-existent) dir; the route
    // should still respond 200 because every readJson tolerates missing files.
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.meta.currentTfSlug).toBe("2h-trend-v5-quartz-lite-r28");
    expect(body.meta.stateDir).toContain(
      "ftmo-state-2h-trend-v5-quartz-lite-r28",
    );
  });

  // Round 57 (2026-05-03): auth gate. When Supabase is configured but the
  // request has no valid session, return 401 — defends against a tenant on
  // the same monitor URL reading another user's equity by guessing the slug.
  it("returns 401 when Supabase is configured but the user is not signed in", async () => {
    // Mock the supabase-server helper directly: it returns a client whose
    // auth.getUser() resolves with no user (i.e. no session cookie present).
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: null }, error: null }),
        },
      }),
    }));
    try {
      const { GET } = await import("@/app/api/drift-data/route");
      const resp = await GET(makeReq());
      expect(resp.status).toBe(401);
    } finally {
      vi.doUnmock("@/lib/supabase-server");
    }
  });

  it("returns 200 when a valid Supabase session is present", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: async () => ({
        auth: {
          getUser: async () => ({
            data: { user: { id: "user-123", email: "u@example.com" } },
            error: null,
          }),
        },
      }),
    }));
    try {
      const { GET } = await import("@/app/api/drift-data/route");
      const resp = await GET(makeReq());
      expect(resp.status).toBe(200);
    } finally {
      vi.doUnmock("@/lib/supabase-server");
    }
  });

  it("allows requests when FTMO_MONITOR_AUTH_BYPASS=1 (single-VPS escape hatch)", async () => {
    process.env.FTMO_MONITOR_AUTH_BYPASS = "1";
    // Even with a Supabase client that would deny, bypass should win.
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: null }, error: null }),
        },
      }),
    }));
    try {
      const { GET } = await import("@/app/api/drift-data/route");
      const resp = await GET(makeReq());
      expect(resp.status).toBe(200);
    } finally {
      vi.doUnmock("@/lib/supabase-server");
      delete process.env.FTMO_MONITOR_AUTH_BYPASS;
    }
  });
});
