import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../middleware";

/**
 * Round 60 Security-Audit (CSP/Middleware): smoke-tests for the
 * per-request nonce-based CSP header that replaced the static
 * `'unsafe-inline'` policy in Round 54 (Finding #3).
 *
 * Scope: only the synthesised behaviour of `middleware.ts` — does not
 * exercise the Supabase session-refresh path (which requires a real
 * cookie + network).
 */
describe("middleware CSP", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Force the unauthenticated branch: no Supabase env -> the Supabase
    // session-refresh is skipped but the CSP header is still applied.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function makeRequest(path = "/"): NextRequest {
    return new NextRequest(new URL(`http://localhost:3000${path}`), {
      headers: { host: "localhost:3000" },
    });
  }

  it("emits a per-request CSP header with a fresh nonce", async () => {
    const r1 = await middleware(makeRequest("/"));
    const r2 = await middleware(makeRequest("/"));
    const csp1 = r1.headers.get("Content-Security-Policy");
    const csp2 = r2.headers.get("Content-Security-Policy");
    expect(csp1).toBeTruthy();
    expect(csp2).toBeTruthy();
    const nonce1 = /'nonce-([a-f0-9]+)'/.exec(csp1!)?.[1];
    const nonce2 = /'nonce-([a-f0-9]+)'/.exec(csp2!)?.[1];
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    // 128-bit randomUUID -> 32 hex chars after dash-strip.
    expect(nonce1!.length).toBe(32);
    expect(nonce1).not.toEqual(nonce2);
  });

  it("does NOT include 'unsafe-inline' in script-src", async () => {
    const resp = await middleware(makeRequest("/"));
    const csp = resp.headers.get("Content-Security-Policy")!;
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc!).not.toContain("'unsafe-inline'");
    expect(scriptSrc!).toContain("'strict-dynamic'");
  });

  it("locks down frame-ancestors / base-uri / form-action", async () => {
    const resp = await middleware(makeRequest("/"));
    const csp = resp.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("retains the Phase-45 connect-src allow-list", async () => {
    const resp = await middleware(makeRequest("/"));
    const csp = resp.headers.get("Content-Security-Policy")!;
    for (const origin of [
      "https://*.supabase.co",
      "wss://*.supabase.co",
      "https://api.binance.com",
      "https://query1.finance.yahoo.com",
    ]) {
      expect(csp).toContain(origin);
    }
  });
});
