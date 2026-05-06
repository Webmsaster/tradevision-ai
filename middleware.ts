import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isPlaceholderSupabaseUrl } from "@/lib/supabase";

/**
 * Round 54 (Finding #3): per-request CSP nonce. Replaces the static
 * `script-src 'self' 'unsafe-inline'` from `next.config.js` (which
 * defeats XSS exfil-mitigation) with `script-src 'self' 'nonce-XYZ'
 * 'strict-dynamic'`. Next.js 13+ auto-propagates the nonce from the
 * `Content-Security-Policy` request-header to its hydration / RSC /
 * font-preload inline scripts, so no layout-side wiring is needed for
 * Next-injected scripts.
 *
 * `style-src` keeps `'unsafe-inline'` because Tailwind v4 injects
 * inline styles, and styles are far less abused than scripts for XSS.
 *
 * The `connect-src` allow-list is preserved verbatim from
 * `next.config.js` — see Phase 45 (R45-API-2) for why.
 */
const CSP_CONNECT_SRC = [
  "'self'",
  "https://*.supabase.co",
  "wss://*.supabase.co",
  "https://api.binance.com",
  "https://fapi.binance.com",
  "wss://stream.binance.com",
  "wss://stream.binance.com:9443",
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
  "https://stooq.com",
  "https://nfs.faireconomy.media",
].join(" ");

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${CSP_CONNECT_SRC}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // R67-r8 audit: explicit fallbacks for non-script contexts. Without
    // these, the PWA service-worker (/sw.js) and manifest could be silently
    // blocked under strict CSP because `worker-src` falls back through
    // child-src/default-src and Chrome historically had quirks where
    // 'strict-dynamic' on script-src propagated to worker creation.
    // object-src 'none' kills <object>/<embed> Flash-style XSS — does NOT
    // fall back from default-src in older browsers, so explicit set required.
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "report-uri /api/csp-report",
  ].join("; ");
}

function generateNonce(): string {
  // crypto.randomUUID() is available on the Edge runtime; we only need
  // 128 bits of entropy. Strip dashes so the value is base64-safe in
  // the CSP header.
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Middleware to refresh the Supabase auth session on every request and
 * to set a per-request nonce-based Content-Security-Policy header.
 *
 * Does NOT block unauthenticated users — the app works without login.
 */
export async function middleware(request: NextRequest) {
  // Generate the nonce up front so it applies to every response below.
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // Pass the nonce down to Next.js so it tags ITS injected inline
  // scripts (hydration / RSC payload / font preloads) with the matching
  // `nonce` attribute. Next.js reads this special request header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Skip Supabase-session refresh if Supabase is not configured, but
  // STILL set the CSP response header so XSS mitigation applies in
  // unauthenticated / local-only mode.
  if (!url || !key || isPlaceholderSupabaseUrl(url)) {
    const resp = NextResponse.next({ request: { headers: requestHeaders } });
    resp.headers.set("Content-Security-Policy", csp);
    return resp;
  }

  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });
  supabaseResponse.headers.set("Content-Security-Policy", csp);

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        // Preserve the nonce-augmented request headers AND re-apply the
        // CSP response header (NextResponse.next clears prior headers).
        supabaseResponse = NextResponse.next({
          request: { headers: requestHeaders },
        });
        supabaseResponse.headers.set("Content-Security-Policy", csp);
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refresh the session — this is the primary purpose of this middleware
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Phase 45 (R45-API-1): the previous matcher actually let `/api/*` through —
    // the comment claimed otherwise but the negation only excluded static
    // assets. Effect: every API hit triggered `auth.getUser()` over the
    // network (50-200ms latency, RLS counter-load, Set-Cookie on JSON
    // responses, race conditions on parallel /api/* calls). Add `api` to
    // the exclusion alongside the static-file extensions.
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
