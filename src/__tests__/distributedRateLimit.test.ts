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
      // Pipeline returns array of {result} per command.
      // Simulate atomic INCR returning the new count.
      return new Response(JSON.stringify([{ result: calls }, { result: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
});
