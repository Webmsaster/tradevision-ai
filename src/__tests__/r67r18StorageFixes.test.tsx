/**
 * R67 Round 18 — deferred R15-A1 + R17-A3 storage fixes.
 *
 * Fix 1 (R15-A1, MEDIUM): clearAllSupabaseTrades accepts an optional
 *   `accountId` parameter so the /import "Replace mode" path
 *   (replaceTrades) only wipes the active account's cloud rows instead
 *   of every account's. A trader with FTMO-Step1 + FTMO-Step2 + Personal
 *   accounts who re-imports their FTMO-Step1 backup must NOT lose
 *   FTMO-Step2 / Personal cloud data.
 *
 * Fix 2 (R17-A3, MEDIUM): saveBulkTradesToSupabase serializes ALL
 *   concurrent calls through a module-level Promise chain so two
 *   simultaneous bulk writes (e.g. /import Replace + a CSV-import fired
 *   in another tab) cannot race on the same retry-queue and silently
 *   lose pending rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearAllSupabaseTrades,
  saveBulkTradesToSupabase,
  _resetBulkSerializerForTests,
  __resetSoftDeleteCacheForTest,
} from "@/utils/storage";
import type { Trade } from "@/types/trade";
import type { SupabaseClient } from "@supabase/supabase-js";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "test-1",
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: "2024-01-01T10:00:00Z",
    exitDate: "2024-01-01T14:00:00Z",
    pnl: 10,
    pnlPercent: 10,
    fees: 0,
    notes: "",
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

const store: Record<string, string> = {};

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  __resetSoftDeleteCacheForTest();
  _resetBulkSerializerForTests();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fix 1 — clearAllSupabaseTrades accountId scoping
// ---------------------------------------------------------------------------

describe("R67-R18 / Fix 1 — clearAllSupabaseTrades accountId scoping", () => {
  function buildUpdateChainMock() {
    const eqCalls: Array<{ col: string; val: unknown }> = [];
    const isCalls: Array<{ col: string; val: unknown }> = [];
    const updateCalled: Array<Record<string, unknown>> = [];

    const updateChain: Record<string, unknown> = {};
    updateChain.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push({ col, val });
      return updateChain;
    });
    updateChain.is = vi.fn((col: string, val: unknown) => {
      isCalls.push({ col, val });
      return Promise.resolve({ error: null });
    });

    const updateFn = vi.fn((patch: Record<string, unknown>) => {
      updateCalled.push(patch);
      return updateChain;
    });

    const fromFn = vi.fn(() => ({ update: updateFn, delete: vi.fn() }));
    return {
      client: { from: fromFn } as unknown as SupabaseClient,
      eqCalls,
      isCalls,
      updateCalled,
    };
  }

  it("issues a per-user wipe (no account_id filter) when accountId omitted", async () => {
    const { client, eqCalls, updateCalled } = buildUpdateChainMock();
    const ok = await clearAllSupabaseTrades(client, "user-1");
    expect(ok).toBe(true);
    expect(updateCalled).toHaveLength(1);
    // Only `user_id` filter — no `account_id` filter (legacy "Clear all" path).
    expect(eqCalls).toEqual([{ col: "user_id", val: "user-1" }]);
  });

  it("adds an account_id eq filter when accountId is provided", async () => {
    const { client, eqCalls, updateCalled } = buildUpdateChainMock();
    const ok = await clearAllSupabaseTrades(client, "user-1", "ftmo-step1");
    expect(ok).toBe(true);
    expect(updateCalled).toHaveLength(1);
    // Both filters present — order-independent, but both must appear.
    expect(eqCalls).toContainEqual({ col: "user_id", val: "user-1" });
    expect(eqCalls).toContainEqual({ col: "account_id", val: "ftmo-step1" });
  });

  it("hard-delete fallback also scopes by account_id when provided", async () => {
    // Force the soft-delete probe into the hard-delete branch by feeding a
    // 42703 error on the first update call, then capture the hard-delete
    // chain to verify the account_id eq is still there.
    const eqCalls: Array<{ col: string; val: unknown }> = [];
    const updateChain: Record<string, unknown> = {};
    updateChain.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push({ col, val });
      return updateChain;
    });
    updateChain.is = vi.fn(() =>
      Promise.resolve({
        error: { code: "42703", message: 'column "deleted_at" does not exist' },
      }),
    );
    const updateFn = vi.fn(() => updateChain);

    const deleteEqCalls: Array<{ col: string; val: unknown }> = [];
    const deleteChain: Record<string, unknown> = {};
    deleteChain.eq = vi.fn((col: string, val: unknown) => {
      deleteEqCalls.push({ col, val });
      // Resolve only when both filters applied (call count == 2 means
      // user_id + account_id). On the bare 1-eq path, return chain again.
      if (deleteEqCalls.length >= 2) {
        return Promise.resolve({ error: null });
      }
      return deleteChain;
    });
    const deleteFn = vi.fn(() => deleteChain);

    const fromFn = vi.fn(() => ({ update: updateFn, delete: deleteFn }));
    const client = { from: fromFn } as unknown as SupabaseClient;

    const ok = await clearAllSupabaseTrades(client, "user-1", "ftmo-step1");
    expect(ok).toBe(true);
    expect(deleteEqCalls).toContainEqual({ col: "user_id", val: "user-1" });
    expect(deleteEqCalls).toContainEqual({
      col: "account_id",
      val: "ftmo-step1",
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — saveBulkTradesToSupabase serialization
// ---------------------------------------------------------------------------

describe("R67-R18 / Fix 2 — saveBulkTradesToSupabase serializes concurrent calls", () => {
  it("never overlaps two upsert chunks even when called concurrently", async () => {
    // Build a Supabase mock whose upsert resolves on a controlled schedule:
    // we record start/finish ticks so we can verify call N+1 starts AFTER
    // call N finishes. Without serialization, two concurrent calls would
    // overlap (start-A, start-B, finish-A, finish-B).
    let inFlight = 0;
    let maxInFlight = 0;
    const timeline: string[] = [];
    const upsertFn = vi.fn(async () => {
      inFlight += 1;
      timeline.push(`start:${inFlight}`);
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield twice to allow other queued promises to attempt to interleave.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      timeline.push(`finish`);
      return { error: null };
    });
    const fromFn = vi.fn(() => ({ upsert: upsertFn }));
    const client = { from: fromFn } as unknown as SupabaseClient;

    // Fire three concurrent bulk-upserts.
    const trades = [makeTrade({ id: "a-1" }), makeTrade({ id: "a-2" })];
    const trades2 = [makeTrade({ id: "b-1" })];
    const trades3 = [makeTrade({ id: "c-1" })];

    const [r1, r2, r3] = await Promise.all([
      saveBulkTradesToSupabase(client, trades, "u1"),
      saveBulkTradesToSupabase(client, trades2, "u1"),
      saveBulkTradesToSupabase(client, trades3, "u1"),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);

    // The serializer must enforce strict sequential execution: at most ONE
    // upsert in flight at any time.
    expect(maxInFlight).toBe(1);

    // Timeline must alternate strictly start → finish → start → ...
    expect(timeline).toEqual([
      "start:1",
      "finish",
      "start:1",
      "finish",
      "start:1",
      "finish",
    ]);
  });

  it("a thrown error in one call does not block subsequent calls", async () => {
    let callIdx = 0;
    const upsertFn = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        // Simulate a thrown rejection (network blow-up) — not a returned
        // {error} which is the normal failure path. The serializer's
        // `.catch(() => undefined)` must keep the chain alive.
        throw new Error("network kaboom");
      }
      return { error: null };
    });
    const fromFn = vi.fn(() => ({ upsert: upsertFn }));
    const client = { from: fromFn } as unknown as SupabaseClient;

    const t1 = [makeTrade({ id: "fail-1" })];
    const t2 = [makeTrade({ id: "ok-1" })];

    const p1 = saveBulkTradesToSupabase(client, t1, "u1");
    const p2 = saveBulkTradesToSupabase(client, t2, "u1");

    await expect(p1).rejects.toThrow(/network kaboom/);
    // Second call must still resolve — the serializer chain didn't latch.
    await expect(p2).resolves.toBe(true);
  });

  it("retry-queue is read+written atomically across concurrent calls (no race-loss)", async () => {
    // Pre-seed retry-queue with one survivor entry. Fire two concurrent
    // calls where the FIRST drain succeeds (queue empties) and the SECOND
    // call uploads cleanly. Without serialization the second call would
    // also read the survivor (since the first hasn't written yet),
    // re-upload it, and write the queue twice — extra work and possible
    // corruption.
    store["sb-retry-queue"] = JSON.stringify([
      {
        rows: [{ id: "queued-1", user_id: "u1" }],
        enqueuedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const upsertedRows: unknown[][] = [];
    const upsertFn = vi.fn(async (rows: unknown[]) => {
      upsertedRows.push(rows);
      return { error: null };
    });
    const fromFn = vi.fn(() => ({ upsert: upsertFn }));
    const client = { from: fromFn } as unknown as SupabaseClient;

    const t1 = [makeTrade({ id: "new-1" })];
    const t2 = [makeTrade({ id: "new-2" })];

    const [r1, r2] = await Promise.all([
      saveBulkTradesToSupabase(client, t1, "u1"),
      saveBulkTradesToSupabase(client, t2, "u1"),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    // Three upsert calls total: one for the survivor, one for t1, one for t2.
    // Without serialization the survivor would be re-uploaded twice (once
    // per concurrent drain) → 4 calls.
    expect(upsertFn).toHaveBeenCalledTimes(3);

    // Queue must be empty on disk after both calls finish.
    expect(store["sb-retry-queue"]).toBeUndefined();
  });
});
