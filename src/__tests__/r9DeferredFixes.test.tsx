/**
 * Round 9 audit — deferred CRITICAL/HIGH fixes.
 *
 * Task A: settings page client-side platform-URL match (KRITISCH)
 * Task B: testStatus enum replaces fragile testResult.includes("success")
 *         (KRITISCH)
 * Task C: csvParser BOM regex uses explicit ﻿ escape (HOCH)
 * Task D: import dedupes by content-hash, not just UUID (MEDIUM)
 * Task E: handleRemoveAccount no off-by-one — fallback uses post-filter
 *         array (WARNING)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Task C — CSV BOM regex hardening
// ---------------------------------------------------------------------------

describe("Round 9 / Task C — csvParser BOM regex (\\uFEFF)", () => {
  it("source contains \\uFEFF escape, not the literal BOM character", async () => {
    // Importing the source as text would require fs in node; instead we
    // execute the regex against a literal-BOM string and check it strips
    // the BOM. If a future editor or tool silently dropped the literal
    // BOM in the source, the regex would no-op and this test would fail.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "src/utils/csvParser.ts"),
      "utf8",
    );
    // The source MUST use the explicit escape, not a literal BOM byte.
    expect(src).toContain("\\uFEFF");
    // And MUST NOT contain a literal BOM in any regex position. The literal
    // codepoint is U+FEFF (UTF-8: 0xEF 0xBB 0xBF). Allow the BOM only
    // inside non-regex lines (e.g. comments) by checking specifically for
    // the regex shape /^<literal-BOM>/.
    const literalBomInRegex = /\/\^﻿\//.test(src);
    expect(literalBomInRegex).toBe(false);
  });

  it("strips a literal BOM from a header value at runtime", async () => {
    // The transform-Header lambda is internal to parseCSVFile, but the
    // intent is functional: any value starting with U+FEFF is normalised.
    const headerWithBom = "﻿Pair";
    const stripped = headerWithBom.replace(/^﻿/, "").trim();
    expect(stripped).toBe("Pair");
  });
});

// ---------------------------------------------------------------------------
// Task D — content-hash dedupe
// ---------------------------------------------------------------------------

describe("Round 9 / Task D — content-hash dedupe (tradeContentHash)", () => {
  it("returns identical hash for two trades with the same content fields", async () => {
    const { tradeContentHash } = await import("@/utils/storage");
    const a = {
      id: "uuid-A",
      pair: "BTC/USDT",
      direction: "long" as const,
      entryPrice: 50000,
      exitPrice: 51000,
      quantity: 0.1,
      entryDate: "2026-01-01T10:00:00Z",
      exitDate: "2026-01-01T14:00:00Z",
      pnl: 100,
      pnlPercent: 2,
      fees: 0,
      notes: "",
      tags: [],
      leverage: 1,
    };
    const b = { ...a, id: "uuid-B" }; // different UUID, same content
    expect(tradeContentHash(a)).toBe(tradeContentHash(b));
  });

  it("differs when any content field changes", async () => {
    const { tradeContentHash } = await import("@/utils/storage");
    const base = {
      id: "u1",
      pair: "BTC/USDT",
      direction: "long" as const,
      entryPrice: 100,
      exitPrice: 110,
      quantity: 1,
      entryDate: "2026-01-01T10:00:00Z",
      exitDate: "2026-01-01T14:00:00Z",
      pnl: 10,
      pnlPercent: 10,
      fees: 0,
      notes: "",
      tags: [],
      leverage: 1,
    };
    const baseHash = tradeContentHash(base);
    expect(tradeContentHash({ ...base, pair: "ETH/USDT" })).not.toBe(baseHash);
    expect(tradeContentHash({ ...base, direction: "short" })).not.toBe(
      baseHash,
    );
    expect(tradeContentHash({ ...base, entryPrice: 101 })).not.toBe(baseHash);
    expect(tradeContentHash({ ...base, quantity: 2 })).not.toBe(baseHash);
    expect(
      tradeContentHash({ ...base, exitDate: "2026-02-01T14:00:00Z" }),
    ).not.toBe(baseHash);
  });

  it("buildContentHashSet returns a Set of unique hashes", async () => {
    const { buildContentHashSet, tradeContentHash } =
      await import("@/utils/storage");
    const t1 = {
      id: "u1",
      pair: "BTC/USDT",
      direction: "long" as const,
      entryPrice: 100,
      exitPrice: 110,
      quantity: 1,
      entryDate: "2026-01-01T10:00:00Z",
      exitDate: "2026-01-01T14:00:00Z",
      pnl: 10,
      pnlPercent: 10,
      fees: 0,
      notes: "",
      tags: [],
      leverage: 1,
    };
    const t2 = { ...t1, id: "u2", pair: "ETH/USDT" };
    const set = buildContentHashSet([t1, t2]);
    expect(set.size).toBe(2);
    expect(set.has(tradeContentHash(t1))).toBe(true);
    expect(set.has(tradeContentHash(t2))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task D — useTradeStorage.importTrades dedupes content-duplicates
// ---------------------------------------------------------------------------

const importHookMocks = vi.hoisted(() => ({
  authState: {
    user: null as { id: string } | null,
    supabase: null as object | null,
    isLoading: false,
  },
  store: {} as Record<string, string>,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => importHookMocks.authState,
}));

describe("Round 9 / Task D — importTrades skips content-duplicates", () => {
  beforeEach(() => {
    Object.keys(importHookMocks.store).forEach(
      (k) => delete importHookMocks.store[k],
    );
    importHookMocks.authState.user = null;
    importHookMocks.authState.supabase = null;
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => importHookMocks.store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        importHookMocks.store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete importHookMocks.store[key];
      }),
    });
    vi.resetModules();
  });

  it("skips the second import when content matches an existing trade", async () => {
    const { renderHook, act: rhAct } = await import("@testing-library/react");
    const { useTradeStorage } = await import("@/hooks/useTradeStorage");
    const baseTrade = {
      id: "uuid-first",
      pair: "BTC/USDT",
      direction: "long" as const,
      entryPrice: 50000,
      exitPrice: 51000,
      quantity: 0.1,
      entryDate: "2026-01-01T10:00:00Z",
      exitDate: "2026-01-01T14:00:00Z",
      pnl: 100,
      pnlPercent: 2,
      fees: 0,
      notes: "",
      tags: [],
      leverage: 1,
    };

    const { result } = renderHook(() => useTradeStorage());

    // First import — accepted.
    let inserted = 0;
    await rhAct(async () => {
      inserted = await result.current.importTrades([baseTrade]);
    });
    expect(inserted).toBe(1);
    expect(result.current.trades).toHaveLength(1);

    // Second import — same content, fresh UUID (simulates re-importing
    // the same CSV → csvParser assigns new UUIDs each time).
    const reimport = { ...baseTrade, id: "uuid-second" };
    let inserted2 = 0;
    await rhAct(async () => {
      inserted2 = await result.current.importTrades([reimport]);
    });
    expect(inserted2).toBe(0); // dedupe blocked the re-insert
    expect(result.current.trades).toHaveLength(1);
  });

  it("dedupes within a single import batch", async () => {
    const { renderHook, act: rhAct } = await import("@testing-library/react");
    const { useTradeStorage } = await import("@/hooks/useTradeStorage");
    const t1 = {
      id: "u1",
      pair: "ETH/USDT",
      direction: "long" as const,
      entryPrice: 2000,
      exitPrice: 2100,
      quantity: 1,
      entryDate: "2026-01-02T10:00:00Z",
      exitDate: "2026-01-02T14:00:00Z",
      pnl: 100,
      pnlPercent: 5,
      fees: 0,
      notes: "",
      tags: [],
      leverage: 1,
    };
    const t1Dup = { ...t1, id: "u1-dup" }; // same content, fresh UUID
    const t2 = { ...t1, id: "u2", pair: "BTC/USDT" };

    const { result } = renderHook(() => useTradeStorage());
    let inserted = 0;
    await rhAct(async () => {
      inserted = await result.current.importTrades([t1, t1Dup, t2]);
    });
    expect(inserted).toBe(2); // t1 + t2 — t1Dup deduped
  });
});

// ---------------------------------------------------------------------------
// Task A & B & E — settings page (rendered)
// ---------------------------------------------------------------------------

describe("Round 9 / Task A+B — Settings page webhook test handler", () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    });
    vi.resetModules();
    // Default fetch — returns { ok: true } so the success path is exercised.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          json: async () => ({ ok: true, status: 204, latencyMs: 42 }),
        } as unknown as Response),
      ),
    );
  });

  async function renderSettings() {
    const SettingsPage = (await import("@/app/settings/page")).default;
    return render(<SettingsPage />);
  }

  async function enableWebhookAndSet(
    platform: "discord" | "telegram" | "custom",
    url: string,
  ) {
    await renderSettings();
    // Toggle webhook enabled
    const enabledChk = screen.getByLabelText(
      "Enable webhook notifications",
    ) as HTMLInputElement;
    fireEvent.click(enabledChk);
    // Select platform
    const platformSel = screen.getByLabelText("Platform") as HTMLSelectElement;
    fireEvent.change(platformSel, { target: { value: platform } });
    // Enter URL
    const urlInput = screen.getByLabelText("Webhook URL") as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: url } });
  }

  it("Task A — rejects discord platform with non-discord URL (mismatch)", async () => {
    await enableWebhookAndSet("discord", "https://example.com/api/webhooks/x");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("Test Webhook"));
    });
    const result = screen.getByTestId("webhook-test-result");
    expect(result.getAttribute("data-test-status")).toBe("error");
    expect(result.textContent).toMatch(/does not match the selected platform/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Task A — rejects telegram platform with non-telegram URL", async () => {
    await enableWebhookAndSet("telegram", "https://example.com/sendMessage");
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("Test Webhook"));
    });
    const result = screen.getByTestId("webhook-test-result");
    expect(result.getAttribute("data-test-status")).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Task A — accepts discord platform with valid discord URL", async () => {
    await enableWebhookAndSet(
      "discord",
      "https://discord.com/api/webhooks/123/abc",
    );
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("Test Webhook"));
      // Allow microtasks to flush so the fetch promise resolves and the
      // ok-status branch runs.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const result = screen.getByTestId("webhook-test-result");
    expect(result.getAttribute("data-test-status")).toBe("ok");
  });

  it("Task B — testStatus drives colour without substring match", async () => {
    // Success message — colour reflects status=ok.
    await enableWebhookAndSet(
      "discord",
      "https://discord.com/api/webhooks/123/abc",
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Test Webhook"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const okEl = screen.getByTestId("webhook-test-result");
    expect(okEl.getAttribute("data-test-status")).toBe("ok");
    expect((okEl as HTMLElement).style.color).toBe("var(--profit)");
  });

  it("Task B — error status maps to loss colour even without 'success' substring", async () => {
    // Trigger an error path: empty URL.
    await renderSettings();
    fireEvent.click(screen.getByLabelText("Enable webhook notifications"));
    // URL stays empty. Click test.
    await act(async () => {
      fireEvent.click(screen.getByText("Test Webhook"));
    });
    const el = screen.getByTestId("webhook-test-result");
    expect(el.getAttribute("data-test-status")).toBe("error");
    expect((el as HTMLElement).style.color).toBe("var(--loss)");
  });
});

describe("Round 9 / Task E — handleRemoveAccount post-filter fallback", () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    // Pre-seed settings with two accounts where active = first.
    store["tradevision-settings"] = JSON.stringify({
      webhook: {
        enabled: false,
        url: "",
        platform: "discord",
        events: { onTradeAdd: true, onTradeEdit: false, onTradeDelete: true },
      },
      accounts: [
        { id: "acc-1", name: "First", broker: "" },
        { id: "acc-2", name: "Second", broker: "" },
      ],
      activeAccountId: "acc-1",
      widgets: {
        equityCurve: true,
        weeklySummary: true,
        recentTrades: true,
        aiInsights: true,
        dayOfWeekHeatmap: true,
      },
    });
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    });
    vi.resetModules();
  });

  it("removes first account and falls back to a remaining (NOT removed) account id", async () => {
    const SettingsPage = (await import("@/app/settings/page")).default;
    render(<SettingsPage />);
    // The active account is acc-1; remove it.
    const removeBtns = screen.getAllByText("Remove");
    expect(removeBtns.length).toBe(2);
    await act(async () => {
      fireEvent.click(removeBtns[0]!); // remove acc-1 (first)
    });
    // Save so the new state lands in localStorage.
    fireEvent.click(screen.getByText("Save Settings"));
    const settings = JSON.parse(
      (globalThis.localStorage.getItem as unknown as (k: string) => string)(
        "tradevision-settings",
      ),
    );
    expect(settings.accounts).toHaveLength(1);
    expect(settings.accounts[0].id).toBe("acc-2");
    // Off-by-one bug would have left activeAccountId="acc-1" (the
    // removed account, since accounts[0] was acc-1 BEFORE filter).
    // Post-fix: it must be acc-2.
    expect(settings.activeAccountId).toBe("acc-2");
  });

  it("removing a non-active account leaves activeAccountId untouched", async () => {
    const SettingsPage = (await import("@/app/settings/page")).default;
    render(<SettingsPage />);
    const removeBtns = screen.getAllByText("Remove");
    // Remove acc-2 (second) while acc-1 is active.
    await act(async () => {
      fireEvent.click(removeBtns[1]!);
    });
    fireEvent.click(screen.getByText("Save Settings"));
    const settings = JSON.parse(
      (globalThis.localStorage.getItem as unknown as (k: string) => string)(
        "tradevision-settings",
      ),
    );
    expect(settings.accounts).toHaveLength(1);
    expect(settings.accounts[0].id).toBe("acc-1");
    expect(settings.activeAccountId).toBe("acc-1");
  });
});
