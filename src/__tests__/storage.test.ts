import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveTrades,
  loadTrades,
  addTrade,
  updateTrade,
  deleteTrade,
  clearAllData,
  importFromJSON,
  hasSavedData,
  loadTradesFromSupabase,
  saveBulkTradesToSupabase,
  deleteTradeFromSupabase,
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

// Mock localStorage
const store: Record<string, string> = {};

beforeEach(() => {
  Object.keys(store).forEach((key) => delete store[key]);
  // Round 56 (Finding #4): reset module-scope soft-delete capability cache
  // between tests so a previous test's failure doesn't latch the next.
  __resetSoftDeleteCacheForTest();

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

describe("saveTrades / loadTrades", () => {
  it("saves and loads trades correctly", () => {
    const trades = [makeTrade(), makeTrade({ id: "test-2", pair: "ETH/USDT" })];
    saveTrades(trades);
    const loaded = loadTrades();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.pair).toBe("BTC/USDT");
    expect(loaded[1]!.pair).toBe("ETH/USDT");
  });

  it("returns empty array when no data stored", () => {
    expect(loadTrades()).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    store["trading-journal-trades"] = "not-valid-json";
    expect(loadTrades()).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    store["trading-journal-trades"] = '{"foo":"bar"}';
    expect(loadTrades()).toEqual([]);
  });

  it("filters out invalid trade objects", () => {
    store["trading-journal-trades"] = JSON.stringify([
      makeTrade(),
      { id: "bad", pair: 123 }, // invalid: pair must be string
      null,
      "not-an-object",
    ]);
    const loaded = loadTrades();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("test-1");
  });

  it("separates screenshots to a separate key", () => {
    const trades = [makeTrade({ screenshot: "data:image/png;base64,abc123" })];
    saveTrades(trades);

    const tradesData = JSON.parse(store["trading-journal-trades"]!);
    expect(tradesData[0].screenshot).toBeUndefined();

    const screenshots = JSON.parse(store["trading-journal-screenshots"]!);
    expect(screenshots["test-1"]).toBe("data:image/png;base64,abc123");
  });

  it("re-attaches screenshots on load", () => {
    store["trading-journal-trades"] = JSON.stringify([makeTrade()]);
    store["trading-journal-screenshots"] = JSON.stringify({
      "test-1": "data:image/png;base64,abc",
    });
    const loaded = loadTrades();
    expect(loaded[0]!.screenshot).toBe("data:image/png;base64,abc");
  });

  // Round 56 (R56-STO-1): a QuotaExceededError on the trades-payload
  // write must broadcast the documented event so the UI can toast.
  // Previously the outer catch swallowed it silently and trades stopped
  // persisting with no signal to the user.
  it("broadcasts QUOTA_EXCEEDED_EVENT on QuotaExceededError", async () => {
    const events: Event[] = [];
    const onQuota = (e: Event) => events.push(e);
    // jsdom provides window/CustomEvent; addEventListener returns void.
    window.addEventListener("tradevision:storage-quota-exceeded", onQuota);

    // Stub localStorage.setItem to throw a DOMException-shaped quota error
    // for the trades key only.
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        if (key === "trading-journal-trades") {
          const err = new Error("QuotaExceededError") as Error & {
            name: string;
            code: number;
          };
          err.name = "QuotaExceededError";
          err.code = 22;
          throw err;
        }
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    });

    saveTrades([makeTrade()]);

    expect(events.length).toBe(1);
    const detail = (events[0] as CustomEvent).detail as {
      tradeCount: number;
      screenshotCount: number;
    };
    expect(detail.tradeCount).toBe(1);
    expect(detail.screenshotCount).toBe(0);

    window.removeEventListener("tradevision:storage-quota-exceeded", onQuota);
  });
});

describe("addTrade", () => {
  it("adds a trade and persists", () => {
    const result = addTrade(makeTrade());
    expect(result).toHaveLength(1);
    expect(loadTrades()).toHaveLength(1);
  });

  it("appends to existing trades", () => {
    addTrade(makeTrade({ id: "a" }));
    const result = addTrade(makeTrade({ id: "b" }));
    expect(result).toHaveLength(2);
  });
});

describe("updateTrade", () => {
  it("updates an existing trade by id", () => {
    addTrade(makeTrade({ id: "a", pair: "BTC/USDT" }));
    const result = updateTrade(makeTrade({ id: "a", pair: "ETH/USDT" }));
    expect(result[0]!.pair).toBe("ETH/USDT");
  });

  it("does nothing if trade id not found", () => {
    addTrade(makeTrade({ id: "a" }));
    const result = updateTrade(
      makeTrade({ id: "non-existent", pair: "SOL/USDT" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
  });
});

describe("deleteTrade", () => {
  it("removes a trade by id", () => {
    addTrade(makeTrade({ id: "a" }));
    addTrade(makeTrade({ id: "b" }));
    const result = deleteTrade("a");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("b");
  });

  it("returns unchanged array if id not found", () => {
    addTrade(makeTrade({ id: "a" }));
    const result = deleteTrade("nonexistent");
    expect(result).toHaveLength(1);
  });
});

describe("clearAllData", () => {
  it("removes all trade data", () => {
    addTrade(makeTrade());
    clearAllData();
    expect(loadTrades()).toEqual([]);
  });
});

describe("hasSavedData", () => {
  it("returns false when no data", () => {
    expect(hasSavedData()).toBe(false);
  });

  it("returns true when trades exist", () => {
    addTrade(makeTrade());
    expect(hasSavedData()).toBe(true);
  });

  it("returns false for empty array", () => {
    store["trading-journal-trades"] = "[]";
    expect(hasSavedData()).toBe(false);
  });
});

describe("importFromJSON", () => {
  function makeFile(content: string): File {
    return new File([content], "test.json", { type: "application/json" });
  }

  it("imports trades from a raw array", async () => {
    const trades = [makeTrade()];
    const file = makeFile(JSON.stringify(trades));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
    expect(result[0]!.pair).toBe("BTC/USDT");
  });

  it("imports trades from a wrapped format", async () => {
    const wrapper = {
      exportDate: "2024-01-01",
      version: "1.0",
      trades: [makeTrade()],
    };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
  });

  it("preserves IDs unless conflict with existing (Phase 30 — Storage Bug 4)", async () => {
    // Phase 30 (Storage Audit Bug 4): regenerate UUIDs only on CONFLICT
    // with existing trades. Preserves AIInsight relatedTrades references
    // when re-importing your own backup.
    const fresh = "fresh-1";
    const wrapper = {
      exportDate: "2024-01-01",
      version: "1.0",
      trades: [
        makeTrade({ id: fresh, pair: "BTC/USDT" }),
        makeTrade({ id: "fresh-2", pair: "ETH/USDT" }),
      ],
    };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(fresh);
    expect(result[1]!.id).toBe("fresh-2");
  });

  it("preserves screenshot data from JSON backup entries", async () => {
    const wrapper = {
      exportDate: "2024-01-01",
      version: "1.0",
      trades: [
        makeTrade({ id: "img-1", screenshot: "data:image/png;base64,abc123" }),
      ],
    };
    const file = makeFile(JSON.stringify(wrapper));
    const result = await importFromJSON(file);
    expect(result).toHaveLength(1);
    expect(result[0]!.screenshot).toBe("data:image/png;base64,abc123");
  });

  it("rejects files with no valid trades", async () => {
    const file = makeFile(JSON.stringify([{ id: "bad" }]));
    await expect(importFromJSON(file)).rejects.toThrow("No valid trades found");
  });

  it("rejects invalid JSON structure", async () => {
    const file = makeFile(JSON.stringify({ something: "else" }));
    await expect(importFromJSON(file)).rejects.toThrow(
      "Invalid JSON structure",
    );
  });

  it("rejects files over 10 MB", async () => {
    const bigContent = "x".repeat(11 * 1024 * 1024);
    const file = new File([bigContent], "big.json", {
      type: "application/json",
    });
    await expect(importFromJSON(file)).rejects.toThrow("File too large");
  });

  it("rejects unparseable JSON", async () => {
    const file = makeFile("not json at all");
    await expect(importFromJSON(file)).rejects.toThrow("Failed to parse JSON");
  });
});

// ---------------------------------------------------------------------------
// Phase 95 (Round 54) regression tests
// ---------------------------------------------------------------------------

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    pair: "BTC/USDT",
    direction: "long",
    entry_price: 100,
    exit_price: 110,
    quantity: 1,
    entry_date: "2024-01-01T10:00:00Z",
    exit_date: "2024-01-01T14:00:00Z",
    pnl: 10,
    pnl_percent: 10,
    fees: 0,
    leverage: 1,
    notes: "",
    tags: [],
    account_id: "default",
    deleted_at: null,
    ...overrides,
  };
}

/**
 * Build a fluent Supabase mock chain. Captures upsert / update / delete
 * call sites so individual tests can assert post-conditions without
 * needing the real client.
 */
function makeSupabaseMock(opts: {
  pages?: Array<unknown[]>;
  upsertErrorAtCall?: number;
  updateError?: { message: string };
  deleteError?: { message: string };
  failOnSoftDeleteColumn?: boolean;
}) {
  const pages = opts.pages ?? [];
  let pageCallIdx = 0;
  let upsertCalls = 0;
  const upsertCalled: Array<unknown[]> = [];
  const updateCalled: Array<Record<string, unknown>> = [];
  const deleteCalled: number[] = [];
  let softDeleteFailureFired = false;

  const rangeFn = vi.fn(() => {
    if (opts.failOnSoftDeleteColumn && !softDeleteFailureFired) {
      softDeleteFailureFired = true;
      return Promise.resolve({
        data: null,
        error: { message: 'column "deleted_at" does not exist' },
      });
    }
    const page = pages[pageCallIdx] ?? [];
    pageCallIdx += 1;
    return Promise.resolve({ data: page, error: null });
  });

  const chain: Record<string, unknown> = {};
  chain.range = rangeFn;
  chain.order = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);

  const selectFn = vi.fn(() => chain);

  const upsertFn = vi.fn((rows: unknown[]) => {
    upsertCalls += 1;
    upsertCalled.push(rows);
    if (opts.upsertErrorAtCall && upsertCalls === opts.upsertErrorAtCall) {
      return Promise.resolve({ error: { message: "chunk failed" } });
    }
    return Promise.resolve({ error: null });
  });

  let updateEqCalls = 0;
  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => {
    updateEqCalls += 1;
    if (updateEqCalls >= 2) {
      return Promise.resolve({ error: opts.updateError ?? null });
    }
    return updateChain;
  });
  updateChain.is = vi.fn(() =>
    Promise.resolve({ error: opts.updateError ?? null }),
  );

  const updateFn = vi.fn((patch: Record<string, unknown>) => {
    updateCalled.push(patch);
    updateEqCalls = 0;
    return updateChain;
  });

  let deleteEqCalls = 0;
  const deleteChain: Record<string, unknown> = {};
  deleteChain.eq = vi.fn(() => {
    deleteEqCalls += 1;
    if (deleteEqCalls >= 2) {
      return Promise.resolve({ error: opts.deleteError ?? null });
    }
    return deleteChain;
  });
  const deleteFn = vi.fn(() => {
    deleteCalled.push(1);
    deleteEqCalls = 0;
    return deleteChain;
  });

  const fromFn = vi.fn(() => ({
    select: selectFn,
    upsert: upsertFn,
    update: updateFn,
    delete: deleteFn,
  }));

  return {
    client: { from: fromFn } as unknown as SupabaseClient,
    upsertCalled,
    updateCalled,
    deleteCalled,
    upsertCallCount: () => upsertCalls,
  };
}

describe("loadTradesFromSupabase — pagination (R54-STO-1)", () => {
  it("walks beyond the old 100k cap until the result-set is exhausted", async () => {
    const PAGE = 1000;
    const TOTAL_PAGES = 250;
    const pages: Array<unknown[]> = Array.from({ length: TOTAL_PAGES }, () =>
      Array.from({ length: PAGE }, (_, j) => makeDbRow({ id: `r-${j}` })),
    );
    pages.push([]);
    const { client } = makeSupabaseMock({ pages });
    const result = await loadTradesFromSupabase(client, "user-1");
    expect(result).toHaveLength(PAGE * TOTAL_PAGES);
  }, 30_000);

  it("falls back when deleted_at column is missing", async () => {
    const pages: Array<unknown[]> = [
      [makeDbRow({ id: "a" }), makeDbRow({ id: "b" })],
    ];
    const { client } = makeSupabaseMock({
      pages,
      failOnSoftDeleteColumn: true,
    });
    const result = await loadTradesFromSupabase(client, "user-1");
    expect(result).toHaveLength(2);
  });
});

describe("saveBulkTradesToSupabase — retry-queue (R54-STO-2)", () => {
  it("enqueues the failing slice when chunk N fails mid-flight", async () => {
    const trades: Trade[] = Array.from({ length: 1200 }, (_, i) =>
      makeTrade({ id: `t-${i}` }),
    );
    const { client, upsertCallCount } = makeSupabaseMock({
      upsertErrorAtCall: 2,
    });
    const ok = await saveBulkTradesToSupabase(client, trades, "user-1");
    expect(ok).toBe(false);
    expect(upsertCallCount()).toBe(2);
    const raw = store["sb-retry-queue"];
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rows.length).toBe(700);
  });

  it("drains the retry-queue on the next successful call", async () => {
    store["sb-retry-queue"] = JSON.stringify([
      {
        rows: Array.from({ length: 200 }, (_, i) => ({ id: `q-${i}` })),
        enqueuedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    const { client, upsertCallCount } = makeSupabaseMock({});
    const ok = await saveBulkTradesToSupabase(client, [], "user-1");
    expect(ok).toBe(true);
    expect(upsertCallCount()).toBe(1);
    expect(store["sb-retry-queue"]).toBeUndefined();
  });
});

describe("dbToTrade — type validation (R54-STO-3)", () => {
  it("normalises garbage NaN / non-array fields", async () => {
    const garbageRow = makeDbRow({
      id: "garbage-1",
      confidence: NaN,
      tags: { not: "array" },
      notes: 12345 as unknown as string,
      direction: "sideways" as unknown as string,
      account_id: "",
      strategy: 42 as unknown as string,
    });
    const { client } = makeSupabaseMock({ pages: [[garbageRow]] });
    const [trade] = await loadTradesFromSupabase(client, "user-1");
    expect(trade!.confidence).toBeUndefined();
    expect(trade!.tags).toEqual([]);
    expect(trade!.notes).toBe("");
    expect(trade!.direction).toBe("long");
    expect(trade!.accountId).toBe("default");
    expect(trade!.strategy).toBeUndefined();
  });
});

describe("deleteTradeFromSupabase — soft-delete (R54-STO-7)", () => {
  it("issues UPDATE deleted_at on a migrated DB", async () => {
    const { client, updateCalled, deleteCalled } = makeSupabaseMock({});
    const ok = await deleteTradeFromSupabase(client, "tid", "user-1");
    expect(ok).toBe(true);
    expect(updateCalled).toHaveLength(1);
    expect(updateCalled[0]!.deleted_at).toBeTypeOf("string");
    expect(deleteCalled).toHaveLength(0);
  });

  it("falls back to hard-delete when deleted_at column missing", async () => {
    const { client, deleteCalled } = makeSupabaseMock({
      updateError: { message: 'column "deleted_at" does not exist' },
    });
    const ok = await deleteTradeFromSupabase(client, "tid", "user-1");
    expect(ok).toBe(true);
    expect(deleteCalled).toHaveLength(1);
  });
});

describe("isValidTrade extended (R54-STO-5)", () => {
  it("drops rows with non-array tags / non-string accountId / NaN numbers", () => {
    const goodRow = {
      id: "g",
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
      leverage: 1,
      notes: "",
      tags: [] as string[],
    };
    const garbageTags = { ...goodRow, id: "gt", tags: { not: "array" } };
    const garbageAccount = { ...goodRow, id: "ga", accountId: 42 };
    const nanPnl = { ...goodRow, id: "nan", pnl: NaN };
    const arr = [goodRow, garbageTags, garbageAccount, nanPnl];
    store["trading-journal-trades"] = JSON.stringify(arr);
    const loaded = loadTrades();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("g");
  });
});
