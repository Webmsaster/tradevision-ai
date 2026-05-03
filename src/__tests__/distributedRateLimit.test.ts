/**
 * Round 54 (Finding #2): distributed rate-limit primitive tests.
 *
 * Validates:
 *   - In-memory fallback throttles after maxHits.
 *   - Upstash path is used when env-vars are set, with mocked fetch.
 *   - On Upstash transport failure, degrade to memory (don't fail-open).
 *   - Different buckets keep independent counters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isRateLimited, __testInternals } from "../utils/distributedRateLimit";

const ORIG_FETCH = globalThis.fetch;

describe("distributedRateLimit — in-memory fallback", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __testInternals.resetMemory();
  });

  it("allows up to maxHits, blocks the (maxHits+1)-th", async () => {
    const opts = { maxHits: 3, windowMs: 60_000 };
    expect(await isRateLimited("test1", "1.2.3.4", opts)).toBe(false); // 1
    expect(await isRateLimited("test1", "1.2.3.4", opts)).toBe(false); // 2
    expect(await isRateLimited("test1", "1.2.3.4", opts)).toBe(false); // 3
    expect(await isRateLimited("test1", "1.2.3.4", opts)).toBe(true); // 4 → blocked
  });

  it("keeps independent counters per bucket", async () => {
    const opts = { maxHits: 2, windowMs: 60_000 };
    expect(await isRateLimited("bucketA", "1.2.3.4", opts)).toBe(false);
    expect(await isRateLimited("bucketA", "1.2.3.4", opts)).toBe(false);
    expect(await isRateLimited("bucketA", "1.2.3.4", opts)).toBe(true);
    // Different bucket — fresh quota.
    expect(await isRateLimited("bucketB", "1.2.3.4", opts)).toBe(false);
    expect(await isRateLimited("bucketB", "1.2.3.4", opts)).toBe(false);
    expect(await isRateLimited("bucketB", "1.2.3.4", opts)).toBe(true);
  });

  it("keeps independent counters per IP", async () => {
    const opts = { maxHits: 1, windowMs: 60_000 };
    expect(await isRateLimited("test", "1.1.1.1", opts)).toBe(false);
    expect(await isRateLimited("test", "1.1.1.1", opts)).toBe(true);
    expect(await isRateLimited("test", "2.2.2.2", opts)).toBe(false);
  });
});

describe("distributedRateLimit — Upstash REST path", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example-redis.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    __testInternals.resetMemory();
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("uses Upstash count when REST creds set", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      // Round 56: pipeline now is [SET NX, INCR]. Result order matches.
      // SET-NX returns "OK" or null, INCR returns the new counter value.
      return new Response(
        JSON.stringify([
          { result: calls === 1 ? "OK" : null },
          { result: calls },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const opts = { maxHits: 2, windowMs: 60_000 };
    expect(await isRateLimited("upstash-test", "9.9.9.9", opts)).toBe(false); // count=1
    expect(await isRateLimited("upstash-test", "9.9.9.9", opts)).toBe(false); // count=2
    expect(await isRateLimited("upstash-test", "9.9.9.9", opts)).toBe(true); // count=3 > 2
    expect(calls).toBe(3);
  });

  it("falls back to memory on Upstash transport failure (not fail-open)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    const opts = { maxHits: 1, windowMs: 60_000 };
    // First call → memory bucket, count=1, not limited yet.
    expect(await isRateLimited("fallback", "5.5.5.5", opts)).toBe(false);
    // Second call → memory bucket, count=2, blocked.
    expect(await isRateLimited("fallback", "5.5.5.5", opts)).toBe(true);
  });

  it("falls back to memory on Upstash non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("server error", { status: 502 });
    }) as typeof fetch;

    const opts = { maxHits: 1, windowMs: 60_000 };
    expect(await isRateLimited("fb2", "6.6.6.6", opts)).toBe(false);
    expect(await isRateLimited("fb2", "6.6.6.6", opts)).toBe(true);
  });

  // Round 56 (Finding #1): TTL must be installed only on the first hit
  // within a window. Otherwise sustained spam keeps refreshing the TTL
  // and the key never expires — counter grows forever, fail-closed.
  it("test_ttl_set_only_on_first_hit", async () => {
    const seenCommands: string[][] = [];
    let counter = 0;
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : [];
      // Capture the command array (each entry is [CMD, ...args]).
      for (const cmd of body) seenCommands.push(cmd as string[]);
      counter += 1;
      // SET-NX returns "OK" only on the first call (key didn't exist),
      // null afterwards. INCR returns the new count.
      return new Response(
        JSON.stringify([
          { result: counter === 1 ? "OK" : null },
          { result: counter },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const opts = { maxHits: 100, windowMs: 60_000 };
    await isRateLimited("ttl-once", "7.7.7.7", opts);
    await isRateLimited("ttl-once", "7.7.7.7", opts);
    await isRateLimited("ttl-once", "7.7.7.7", opts);

    // Across 3 calls we must have issued SET ... NX EX exactly 3 times
    // (one per call — Upstash itself rejects the 2nd/3rd via NX).
    // The CRITICAL property is that NO `EXPIRE` command appears — that
    // would re-set TTL and reproduce the bug.
    const setNxCalls = seenCommands.filter(
      (c) => c[0] === "SET" && c.includes("NX") && c.includes("EX"),
    );
    const expireCalls = seenCommands.filter((c) => c[0] === "EXPIRE");
    expect(setNxCalls.length).toBe(3); // one SET-NX per request
    expect(expireCalls.length).toBe(0); // no TTL re-set
  });

  it("logs once on Upstash auth failure (401/403)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    const opts = { maxHits: 1, windowMs: 60_000 };
    // First hit → falls back to memory; auth-error logged.
    expect(await isRateLimited("auth-fail", "8.8.8.8", opts)).toBe(false);
    // Second hit → auth-error log NOT repeated (once-per-process).
    expect(await isRateLimited("auth-fail", "8.8.8.8", opts)).toBe(true);

    const authLogs = errSpy.mock.calls.filter((args) =>
      String(args[0]).includes("Upstash auth failed"),
    );
    expect(authLogs.length).toBe(1);
    errSpy.mockRestore();
  });
});
