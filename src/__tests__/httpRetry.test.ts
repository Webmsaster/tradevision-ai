import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchJsonWithRetry, parseRetryAfter } from "@/utils/httpRetry";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("httpRetry — fetchJsonWithRetry", () => {
  it("retries on 429 with exponential backoff (1s, 2s) and succeeds on attempt 3", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return new Response("rate limited", { status: 429 });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const result = await fetchJsonWithRetry<{ ok: boolean }>(
      "https://example.test/x",
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    // Round 56 Fix 3: backoff schedule = 1000 * 2 ** retry, so 1s then 2s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("respects Retry-After header (delta-seconds) on 429, overriding base backoff", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "7" },
        });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    await fetchJsonWithRetry<{ ok: boolean }>("https://example.test/x", {
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(sleeps).toEqual([7000]);
    expect(calls).toBe(2);
  });

  it("throws final error after maxRetries exhausted", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    await expect(
      fetchJsonWithRetry("https://example.test/x", {
        maxRetries: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("does NOT retry on 4xx other than 429", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      fetchJsonWithRetry("https://example.test/x", { maxRetries: 5 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  it("retries on AbortSignal timeout (network error path)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error("timeout");
        err.name = "TimeoutError";
        throw err;
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const result = await fetchJsonWithRetry<{ ok: boolean }>(
      "https://example.test/x",
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });
});

describe("httpRetry — parseRetryAfter", () => {
  it("parses delta-seconds form", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses HTTP-date form against a frozen `now`", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = "Thu, 01 Jan 2026 00:00:10 GMT";
    expect(parseRetryAfter(future, now)).toBe(10_000);
  });

  it("returns null for invalid / missing headers", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
  });

  it("clamps absurdly long retry-after to a 30s ceiling", () => {
    // 1 hour delta-seconds → clamped
    expect(parseRetryAfter("3600")).toBe(30_000);
  });
});
