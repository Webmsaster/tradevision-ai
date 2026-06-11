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
  afterEach,
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

  // Peak-state — R67-r14 audit fix: API now reads `challenge-peak.json`
  // (the file Python actually writes via update_challenge_peak) instead
  // of the never-produced `peak-state.json`. Field names mirror the
  // Python writer: `peak_equity_usd` + `last_update_ts`.
  fs.writeFileSync(
    path.join(testStateDir, "challenge-peak.json"),
    JSON.stringify({
      peak_equity_usd: 103_000,
      last_update_ts: "2026-04-26T12:00:00Z",
      started_at: "2026-04-26",
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
    // 2026-05-16 Round 9-Final: drift-data now fail-CLOSED when Supabase
    // unavailable unless FTMO_MONITOR_AUTH_BYPASS=1 is set. Test env has
    // no Supabase configured → set bypass so existing tests run against
    // the headless single-VPS path (which is the intended dev semantic).
    // The dedicated "fail-closed without bypass" test removes the env var
    // explicitly.
    process.env.FTMO_MONITOR_AUTH_BYPASS = "1";
  });
  afterEach(() => {
    delete process.env.FTMO_MONITOR_AUTH_BYPASS;
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

    // Drift: live +2.5% on day 3, R28_V6_PASSLOCK median grows to +8% (FTMO
    // step-1 target) by day 4 → at day 3 = (8/4)*3 = 6.0%
    // → drift = 2.5 - 6.0 = -3.5 (slightly underperforming)
    expect(body.drift).not.toBeNull();
    expect(body.drift.driftPct).toBeCloseTo(-3.5, 1);

    // Backtest band: 31 entries (day 0..30)
    expect(body.backtestBand).toHaveLength(31);
    expect(body.backtestBand[0].median).toBe(0);
    expect(body.backtestBand[4].median).toBeCloseTo(8, 5);

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
    expect(body.meta.backtestRef.name).toBe("R28_V6_PASSLOCK");
    expect(body.meta.backtestRef.passRatePct).toBe(64.77);
  });

  it("flags pass status as 'passed' when total P&L ≥ +10% AND min trading days met", async () => {
    fs.writeFileSync(
      path.join(testStateDir, "account.json"),
      JSON.stringify({
        equity: 1.105,
        day: 5,
        raw_equity_usd: 110_500,
      }),
    );
    // 2026-05-14 Codex Wave-2 Bug #5: passStatus now also requires
    // FTMO min-trading-days (4) AND not paused. Provide v4-engine.json
    // to clear both gates.
    fs.writeFileSync(
      path.join(testStateDir, "v4-engine.json"),
      JSON.stringify({
        tradingDays: [0, 1, 2, 3, 4],
        pausedAtTarget: false,
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
    fs.rmSync(path.join(testStateDir, "v4-engine.json"), { force: true });
  });

  it("does NOT flag pass when +10% but min-trading-days < 4 (FTMO rule)", async () => {
    fs.writeFileSync(
      path.join(testStateDir, "account.json"),
      JSON.stringify({
        equity: 1.105,
        day: 2,
        raw_equity_usd: 110_500,
      }),
    );
    fs.writeFileSync(
      path.join(testStateDir, "v4-engine.json"),
      JSON.stringify({ tradingDays: [0, 1], pausedAtTarget: false }),
    );
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq());
    const body = await resp.json();
    expect(body.header.passStatus).toBe("active");

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
    fs.rmSync(path.join(testStateDir, "v4-engine.json"), { force: true });
  });

  it("returns 404 when FTMO_MONITOR_ENABLED is unset", async () => {
    delete process.env.FTMO_MONITOR_ENABLED;
    const { GET } = await import("@/app/api/drift-data/route");
    const resp = await GET(makeReq());
    expect(resp.status).toBe(404);
  });

  it("rejects ftmo_tf slugs with invalid characters (path-traversal guard)", async () => {
    const { GET } = await import("@/app/api/drift-data/route");
    // Lowercase-only whitelist (2026-05-24 Codex audit revert of the
    // Wave-2 widening). Must reject path-traversal characters
    // (`.`, `/`, `\`) and over-length slugs.
    const bad = ["../etc", "foo/bar", "x".repeat(80), "..", ""];
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

  it("rejects uppercase + underscore slugs (lowercase-only contract)", async () => {
    const { GET } = await import("@/app/api/drift-data/route");
    // 2026-05-24 Codex audit MED FIX (commit 38489c6): the 2026-05-14
    // widening to uppercase + underscore was REVERTED. The design contract
    // is lowercase-only so the route regex matches both the SQL CHECK in
    // migration_r29_user_ftmo_accounts.sql and the userFtmoAccounts.test.ts
    // contract (which filters "UPPER" slugs). Multi-account state-dir paths
    // are driven by FTMO_ACCOUNT_ID env, not the slug, so this does not
    // break multi-account routing.
    const rejected = ["Account_A", "FOO", "x1_y2-z3"];
    for (const slug of rejected) {
      const resp = await GET(makeReq(`?ftmo_tf=${encodeURIComponent(slug)}`));
      expect(resp.status).toBe(400);
    }
    // Lowercase equivalents stay accepted.
    const accepted = ["account-a", "foo", "x1-y2-z3"];
    for (const slug of accepted) {
      const resp = await GET(makeReq(`?ftmo_tf=${encodeURIComponent(slug)}`));
      expect(resp.status).toBe(200);
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
    // 2026-05-16 Round 9-Final: this test verifies the AUTH-required path,
    // so explicitly remove the bypass that the global beforeEach sets.
    delete process.env.FTMO_MONITOR_AUTH_BYPASS;
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

  // R67-Final (R14-A7, 2026-05-07): cross-tenant slug enumeration mitigation.
  // Non-admin authenticated users must not be able to read arbitrary
  // state-dirs via `?ftmo_tf=<slug>` — they could otherwise enumerate other
  // tenants' live equity. Admin (FTMO_ADMIN_EMAIL match) keeps full access.
  describe("R67-Final cross-tenant slug enumeration guard", () => {
    it("blocks slug-based reads for non-admin authenticated users (403)", async () => {
      // 2026-05-16 Round 9-Final: AUTH-required path, remove bypass.
      delete process.env.FTMO_MONITOR_AUTH_BYPASS;
      process.env.FTMO_ADMIN_EMAIL = "admin@example.com";
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: {
                user: { id: "user-attacker", email: "attacker@example.com" },
              },
              error: null,
            }),
          },
        }),
      }));
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
        expect(resp.status).toBe(403);
      } finally {
        vi.doUnmock("@/lib/supabase-server");
        delete process.env.FTMO_ADMIN_EMAIL;
      }
    });

    it("allows slug-based reads for the admin email (200)", async () => {
      process.env.FTMO_ADMIN_EMAIL = "admin@example.com";
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: { user: { id: "user-admin", email: "admin@example.com" } },
              error: null,
            }),
          },
        }),
      }));
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.meta.currentTfSlug).toBe("2h-trend-v5-quartz-lite-r28");
      } finally {
        vi.doUnmock("@/lib/supabase-server");
        delete process.env.FTMO_ADMIN_EMAIL;
      }
    });

    it("admin email match is case-insensitive", async () => {
      process.env.FTMO_ADMIN_EMAIL = "Admin@Example.com";
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: { user: { id: "user-admin", email: "ADMIN@example.com" } },
              error: null,
            }),
          },
        }),
      }));
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
        expect(resp.status).toBe(200);
      } finally {
        vi.doUnmock("@/lib/supabase-server");
        delete process.env.FTMO_ADMIN_EMAIL;
      }
    });

    it("non-admin can still read the default state-dir (no slug param)", async () => {
      process.env.FTMO_ADMIN_EMAIL = "admin@example.com";
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: {
                user: { id: "user-tenant", email: "tenant@example.com" },
              },
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
        delete process.env.FTMO_ADMIN_EMAIL;
      }
    });

    it("blocks slug reads when FTMO_ADMIN_EMAIL is unset (fail-closed)", async () => {
      // No FTMO_ADMIN_EMAIL → no user can pass a slug. Default-dir reads
      // still work (covered above).
      // 2026-05-16 Round 9-Final: AUTH-required path, remove bypass.
      delete process.env.FTMO_MONITOR_AUTH_BYPASS;
      delete process.env.FTMO_ADMIN_EMAIL;
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: { user: { id: "user-1", email: "anyone@example.com" } },
              error: null,
            }),
          },
        }),
      }));
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
        expect(resp.status).toBe(403);
      } finally {
        vi.doUnmock("@/lib/supabase-server");
      }
    });

    it("FTMO_MONITOR_AUTH_BYPASS=1 still allows slug reads (single-owner VPS)", async () => {
      process.env.FTMO_MONITOR_AUTH_BYPASS = "1";
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq("?ftmo_tf=2h-trend-v5-quartz-lite-r28"));
        expect(resp.status).toBe(200);
      } finally {
        delete process.env.FTMO_MONITOR_AUTH_BYPASS;
      }
    });
  });

  // R4 audit (2026-05-12, Bug-Audit Round 4 — Multi-Account State):
  // end-to-end multi-tenant isolation for `meta.availableTfSlugs`. A
  // non-admin authenticated user must only see the slugs they're mapped
  // to in `user_ftmo_accounts` — never the full set of slugs that exist
  // on disk (which would let them enumerate other tenants' bot names +
  // liveness via the drift-data /403 timing channel afterwards).
  describe("R4 cross-tenant slug picker isolation", () => {
    it("non-admin user only sees their mapped slugs in availableTfSlugs", async () => {
      // 2026-05-16 Round 9-Final: AUTH-required path, remove bypass.
      delete process.env.FTMO_MONITOR_AUTH_BYPASS;
      // The default state-dir from beforeAll is already on disk; add a
      // sibling so the picker has two slugs to discriminate between.
      const cwd = process.cwd();
      const siblingDir = path.join(cwd, "ftmo-state-tenant-b-only");
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.writeFileSync(path.join(siblingDir, "account.json"), "{}");

      // Mock supabase: authenticated tenant-A user; `user_ftmo_accounts`
      // maps them to `tenant-a-only` only. The query builder must be both
      // chainable AND awaitable (thenable) because the route uses two
      // shapes: getAllowedSlugsForUser (single .eq → array) and
      // canUserReadSlug (.eq().eq().limit(1) → array).
      const mappedRows = [{ tf_slug: "tenant-a-only" }];
      const makeQuery = () => {
        const filters: Array<[string, string]> = [];
        const run = () => {
          const userOk = filters.some(
            ([c, v]) => c === "user_id" && v === "user-tenant-a",
          );
          if (!userOk) return { data: [], error: null };
          const slugEq = filters.find(([c]) => c === "tf_slug");
          const data = slugEq
            ? mappedRows.filter((r) => r.tf_slug === slugEq[1])
            : mappedRows;
          return { data, error: null };
        };
        const q = {
          eq(col: string, val: string) {
            filters.push([col, val]);
            return q;
          },
          limit(_n: number) {
            return q;
          },
          then(
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) {
            return Promise.resolve(run()).then(onFulfilled, onRejected);
          },
        };
        return q;
      };
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: { user: { id: "user-tenant-a", email: "a@example.com" } },
              error: null,
            }),
          },
          from: (_table: string) => ({
            select: () => makeQuery(),
          }),
        }),
      }));
      try {
        // Also create a tenant-a-only dir so the picker can include it.
        const tenantADir = path.join(cwd, "ftmo-state-tenant-a-only");
        fs.mkdirSync(tenantADir, { recursive: true });
        fs.writeFileSync(path.join(tenantADir, "account.json"), "{}");
        try {
          const { GET } = await import("@/app/api/drift-data/route");
          // 2026-05-24 Codex audit HIGH FIX (commit 7f7061f): a non-admin
          // request WITHOUT ?ftmo_tf= no longer falls through to the
          // DEFAULT state-dir (that leaked the operator's own equity to
          // every authenticated tenant) — it now fails closed with 403.
          const blocked = await GET(makeReq());
          expect(blocked.status).toBe(403);
          // Tenants must request a slug they're explicitly mapped to.
          const resp = await GET(makeReq("?ftmo_tf=tenant-a-only"));
          expect(resp.status).toBe(200);
          const body = await resp.json();
          // Non-admin must see ONLY `tenant-a-only` — not `tenant-b-only`,
          // not the default "" slug, not any of the other prod state-dirs.
          expect(body.meta.availableTfSlugs).toContain("tenant-a-only");
          expect(body.meta.availableTfSlugs).not.toContain("tenant-b-only");
        } finally {
          fs.rmSync(tenantADir, { recursive: true, force: true });
        }
      } finally {
        vi.doUnmock("@/lib/supabase-server");
        fs.rmSync(siblingDir, { recursive: true, force: true });
      }
    });

    it("admin sees every slug discoverable on disk", async () => {
      const cwd = process.cwd();
      const t1 = path.join(cwd, "ftmo-state-admin-vis-1");
      const t2 = path.join(cwd, "ftmo-state-admin-vis-2");
      fs.mkdirSync(t1, { recursive: true });
      fs.mkdirSync(t2, { recursive: true });
      process.env.FTMO_ADMIN_EMAIL = "admin@example.com";
      vi.doMock("@/lib/supabase-server", () => ({
        createServerSupabaseClient: async () => ({
          auth: {
            getUser: async () => ({
              data: {
                user: { id: "u-admin", email: "admin@example.com" },
              },
              error: null,
            }),
          },
        }),
      }));
      try {
        const { GET } = await import("@/app/api/drift-data/route");
        const resp = await GET(makeReq());
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.meta.availableTfSlugs).toContain("admin-vis-1");
        expect(body.meta.availableTfSlugs).toContain("admin-vis-2");
      } finally {
        vi.doUnmock("@/lib/supabase-server");
        delete process.env.FTMO_ADMIN_EMAIL;
        fs.rmSync(t1, { recursive: true, force: true });
        fs.rmSync(t2, { recursive: true, force: true });
      }
    });
  });

  // R4 audit (2026-05-12): readJsonl cache invalidation on file rotation.
  // Python rotates executor-log.jsonl by `path.rename(archive)` + reopen,
  // creating a new inode at the same path. Without an inode in the cache
  // key, a worst-case rotation-then-rewrite to identical (mtime, size)
  // would serve stale entries. With the R4 fix, the inode disambiguates.
  describe("R4 readJsonl cache rotation safety", () => {
    it("cache invalidates when the underlying inode changes", async () => {
      // Use the FTMO_STATE_DIR from beforeAll which already has an
      // executor-log.jsonl. Build module fresh, hit it once, rotate, hit
      // again, and ensure the response reflects the post-rotation file.
      const logPath = path.join(testStateDir, "executor-log.jsonl");
      // First request: cache populated with v1 entries.
      const { GET } = await import("@/app/api/drift-data/route");
      const r1 = await GET(makeReq());
      expect(r1.status).toBe(200);
      const b1 = await r1.json();
      expect(b1.recentEvents.length).toBeGreaterThan(0);
      // Rotate: rename current away, write a new file with a single
      // distinct marker event. New inode, possibly different mtime/size.
      const archive = `${logPath}.r4-archive`;
      fs.renameSync(logPath, archive);
      try {
        const marker = {
          ts: new Date().toISOString(),
          event: "r4_post_rotation_marker",
        };
        fs.writeFileSync(logPath, JSON.stringify(marker) + "\n");
        const r2 = await GET(makeReq());
        expect(r2.status).toBe(200);
        const b2 = await r2.json();
        // Must see the new marker event, NOT just the pre-rotation entries.
        const sawMarker = (b2.recentEvents as Array<{ event: string }>).some(
          (e) => e.event === "r4_post_rotation_marker",
        );
        expect(sawMarker).toBe(true);
      } finally {
        // Restore original log so subsequent tests pass.
        fs.renameSync(archive, logPath);
      }
    });
  });
});
