/**
 * Regression tests for `requireFtmoMonitorAuth` — added 2026-05-16 by Codex
 * audit Bug #5 (NORMAL Security: fail-OPEN auth).
 *
 * Contract:
 *   - FTMO_MONITOR_AUTH_BYPASS=1 → ok:true reason:"bypass"
 *   - Otherwise: every failure path (createServerSupabaseClient throws,
 *     returns null, getUser errors, getUser throws) must return ok:false.
 *     Previously these paths returned ok:true → live equity / positions
 *     leaked on any deployment where Supabase was not wired.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("requireFtmoMonitorAuth — Codex audit Bug #5 fail-CLOSED", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.FTMO_MONITOR_AUTH_BYPASS;
  });

  it("FTMO_MONITOR_AUTH_BYPASS=1 → ok:true", async () => {
    process.env.FTMO_MONITOR_AUTH_BYPASS = "1";
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("bypass");
    delete process.env.FTMO_MONITOR_AUTH_BYPASS;
  });

  it("createServerSupabaseClient returns null → ok:false (was ok:true, the bug)", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue(null),
    }));
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-auth-backend");
  });

  it("createServerSupabaseClient throws → ok:false (was ok:true, the bug)", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: vi.fn().mockImplementation(() => {
        throw new Error("cookies() outside request scope");
      }),
    }));
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("auth-backend-error");
  });

  it("auth.getUser returns error → ok:false", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValue({
              data: { user: null },
              error: new Error("oops"),
            }),
        },
      }),
    }));
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(false);
  });

  it("auth.getUser throws → ok:false (was ok:true with no reason flag)", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockImplementation(() => {
            throw new Error("network down");
          }),
        },
      }),
    }));
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("auth-getuser-throw");
  });

  it("auth.getUser returns user → ok:true (happy path)", async () => {
    vi.doMock("@/lib/supabase-server", () => ({
      createServerSupabaseClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "u-123" } },
            error: null,
          }),
        },
      }),
    }));
    const { requireFtmoMonitorAuth } = await import("@/lib/ftmoMonitorAuth");
    const r = await requireFtmoMonitorAuth();
    expect(r.ok).toBe(true);
  });
});
