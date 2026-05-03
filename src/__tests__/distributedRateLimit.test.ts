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
      // Round 58: single EVAL command, response is { result: <count> }.
      return new Response(JSON.stringify({ result: calls }), {
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

  // Round 58 (Critical Fix #1): atomicity regression. Upstash REST
  // `/pipeline` runs commands SEQUENTIALLY, not as a transaction; the
  // SET-NX + INCR shape had a TOCTOU window where the key could expire
  // between the two commands and INCR would re-create it without TTL.
  // Lua EVAL is atomic — verify we issue exactly one EVAL per call,
  // never SET-NX or EXPIRE separately, and that the script body wires
  // INCR + conditional EXPIRE in one indivisible operation.
  it("uses single atomic EVAL — no separate SET-NX or EXPIRE commands", async () => {
    const sentBodies: unknown[] = [];
    let counter = 0;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      sentBodies.push({ url, body });
      counter += 1;
      // EVAL response shape: { result: <number> } on the `/` endpoint.
      return new Response(JSON.stringify({ result: counter }), { status: 200 });
    }) as typeof fetch;

    const opts = { maxHits: 100, windowMs: 60_000 };
    await isRateLimited("atomic-eval", "7.7.7.7", opts);
    await isRateLimited("atomic-eval", "7.7.7.7", opts);
    await isRateLimited("atomic-eval", "7.7.7.7", opts);

    // 1 fetch per call. Each body is a single EVAL command (NOT a
    // pipeline array of commands). No separate SET-NX or EXPIRE.
    expect(sentBodies.length).toBe(3);
    for (const sent of sentBodies) {
      const s = sent as { url: string; body: unknown[] };
      // Endpoint is `/`, not `/pipeline`.
      expect(s.url.endsWith("/pipeline")).toBe(false);
      expect(Array.isArray(s.body)).toBe(true);
      // Single-command shape: ["EVAL", script, "1", key, ttl].
      expect(s.body[0]).toBe("EVAL");
      // Script wires INCR + conditional EXPIRE atomically.
      expect(String(s.body[1])).toContain("INCR");
      expect(String(s.body[1])).toContain("EXPIRE");
      // Never a separate SET / EXPIRE issued at top level.
      expect(s.body[0]).not.toBe("SET");
      expect(s.body[0]).not.toBe("EXPIRE");
    }
  });

  // Round 58: regression — first hit (key not yet existing) → EVAL
  // returns 1, the EXPIRE branch inside the Lua script fires exactly
  // once. Subsequent calls return N>1, EXPIRE branch is skipped.
  // We can't observe the inner EXPIRE call from the outside (it's all
  // inside Lua), but we can verify the return-value contract.
  it("first hit returns 1 (key created); subsequent hits return N", async () => {
    let counter = 0;
    globalThis.fetch = vi.fn(async () => {
      counter += 1;
      return new Response(JSON.stringify({ result: counter }), { status: 200 });
    }) as typeof fetch;

    // maxHits high enough that no call is throttled.
    const opts = { maxHits: 100, windowMs: 60_000 };
    expect(await isRateLimited("eval-first", "8.8.8.8", opts)).toBe(false); // count=1 (created)
    expect(await isRateLimited("eval-first", "8.8.8.8", opts)).toBe(false); // count=2
    expect(await isRateLimited("eval-first", "8.8.8.8", opts)).toBe(false); // count=3
    expect(counter).toBe(3);
  });

  // Round 58: regression — when the EVAL endpoint's response indicates
  // a non-OK / non-numeric result, we return null (memory fallback).
  it("falls back to memory when EVAL returns non-numeric result", async () => {
    globalThis.fetch = vi.fn(async () => {
      // Invalid response shape — no { result: number } field.
      return new Response(JSON.stringify({ result: { unexpected: true } }), {
        status: 200,
      });
    }) as typeof fetch;

    const opts = { maxHits: 1, windowMs: 60_000 };
    expect(await isRateLimited("eval-bad-shape", "9.9.9.9", opts)).toBe(false);
    expect(await isRateLimited("eval-bad-shape", "9.9.9.9", opts)).toBe(true);
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
