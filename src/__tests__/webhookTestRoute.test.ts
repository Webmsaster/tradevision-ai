/**
 * Round 54 (Finding #5): server-side webhook-test route tests.
 *
 * Validates the full SSRF defence chain:
 *   1. isValidHttpsUrl rejects http/javascript/literal-private IPs.
 *   2. dns.lookup rejects DNS-rebinding-style hostnames (resolved to
 *      private/loopback addresses).
 *   3. redirect: "manual" surfaces 30x as failure instead of following.
 *   4. AbortSignal.timeout caps requests at 5s.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:dns/promises", async () => {
  const lookup = vi.fn();
  return {
    default: { lookup },
    lookup,
  };
});

import { lookup } from "node:dns/promises";

// `dns.lookup` has overloads that return either `LookupAddress` or
// `LookupAddress[]` depending on `options.all`. We always pass
// `{ all: true }` in the route, so cast the mock to "any flavour" for
// the test setup.
const mockLookup = vi.mocked(
  lookup as unknown as (host: string) => Promise<unknown>,
);

const ORIG_FETCH = globalThis.fetch;

async function callRoute(body: unknown) {
  const { POST } = await import("@/app/api/webhook-test/route");
  const req = new Request("http://localhost/api/webhook-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await POST(req);
  return { resp, body: await resp.json() };
}

describe("/api/webhook-test — input validation", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLookup.mockReset();
  });

  it("rejects malformed JSON body", async () => {
    const { POST } = await import("@/app/api/webhook-test/route");
    const req = new Request("http://localhost/api/webhook-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/JSON/i);
  });

  it("rejects http (cleartext) URLs", async () => {
    const { body } = await callRoute({ url: "http://example.com/" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/HTTPS|public host/i);
  });

  it("rejects literal private-IP URLs (no DNS even tried)", async () => {
    const { body } = await callRoute({ url: "https://10.0.0.1/admin" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/HTTPS|public host/i);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects AWS metadata literal", async () => {
    const { body } = await callRoute({
      url: "https://169.254.169.254/latest/meta-data/",
    });
    expect(body.ok).toBe(false);
  });

  it("rejects URLs longer than 2048 chars", async () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const { resp, body } = await callRoute({ url: longUrl });
    expect(resp.status).toBe(400);
    expect(body.error).toMatch(/too long/i);
  });
});

describe("/api/webhook-test — DNS rebinding defence", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLookup.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  it("rejects hostname that resolves to a private IP (rebinding)", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    // fetch should never be called.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const { body } = await callRoute({ url: "https://attacker.example/" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/private|internal/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects hostname resolving to loopback ::1", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "::1", family: 6 }]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const { body } = await callRoute({ url: "https://evil.example/" });
    expect(body.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects hostname with mixed public+private addresses", async () => {
    // Even one private address must fail (CDN-style multi-A records).
    mockLookup.mockResolvedValueOnce([
      { address: "1.2.3.4", family: 4 },
      { address: "192.168.1.50", family: 4 },
    ]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const { body } = await callRoute({ url: "https://mixed.example/" });
    expect(body.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 with helpful message when DNS lookup fails", async () => {
    mockLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const { resp, body } = await callRoute({ url: "https://nx.example/" });
    expect(resp.status).toBe(400);
    expect(body.error).toMatch(/DNS|lookup/i);
  });
});

describe("/api/webhook-test — happy path + redirect refusal", () => {
  beforeEach(() => {
    vi.resetModules();
    mockLookup.mockReset();
    // All public-route tests resolve to 1.1.1.1 (Cloudflare, public).
    mockLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
  });

  it("returns ok=true on 200 response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const { body } = await callRoute({
      url: "https://hooks.example.com/abc",
      platform: "discord",
    });
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses to follow redirects (manual mode)", async () => {
    globalThis.fetch = vi.fn(async () => {
      // Simulate manual-redirect surfacing as 302.
      return new Response(null, {
        status: 302,
        headers: { Location: "https://10.0.0.1/" },
      });
    }) as typeof fetch;

    const { body } = await callRoute({ url: "https://hooks.example.com/r" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/redirect/i);
  });

  it("surfaces non-2xx as ok=false with status", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("bad", { status: 500, statusText: "Server Error" });
    }) as typeof fetch;

    const { body } = await callRoute({ url: "https://hooks.example.com/x" });
    expect(body.ok).toBe(false);
    expect(body.status).toBe(500);
  });

  it("handles fetch errors gracefully without leaking error details (Round 6 CRITICAL)", async () => {
    // Round 6 audit: server-side error message must NEVER echo the
    // underlying error (which leaks internal hostnames/IPs/cert paths).
    // Verify the response surfaces the generic "Request failed" only.
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET to internal-host-10.2.0.5");
    }) as typeof fetch;

    const { body } = await callRoute({ url: "https://hooks.example.com/y" });
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Request failed");
    // Server-side log MUST still capture the specific error for ops.
    expect(consoleSpy).toHaveBeenCalledWith(
      "[webhook-test]",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("preserves the specific timeout message (operator UX)", async () => {
    // Round 6 audit: timeout branch may stay specific — it tells the user
    // "your URL hung", which is actionable and reveals nothing internal.
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("Timed out");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;

    const { body } = await callRoute({ url: "https://hooks.example.com/t" });
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/timed out/i);
  });
});
