import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

// Phase 70 (R45-API-6): in-memory rate-limit on /api/auth/callback.
// Without this, a brute-force attacker could spray invalid `code`
// parameters to amplify load on Supabase's exchangeCodeForSession
// endpoint (and pollute logs). 10 attempts/min/IP is generous for
// real users (whose code exchange normally happens once per login).
const callbackHits = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 10;
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (callbackHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  hits.push(now);
  callbackHits.set(ip, hits);
  // Opportunistic GC of stale IP entries.
  if (callbackHits.size > 1000) {
    for (const [k, v] of callbackHits) {
      if (v.every((t) => now - t > RATE_WINDOW_MS)) callbackHits.delete(k);
    }
  }
  return hits.length > RATE_MAX_HITS;
}

/**
 * Auth callback handler for Supabase email confirmation and OAuth redirects.
 * After confirming their email, users are redirected here, and we exchange
 * the auth code for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // Phase 92 (R51-S6): prefer the platform-injected `x-vercel-forwarded-for`
  // / `x-real-ip` because they're set BY the platform proxy, not user-
  // controllable. Fall back to `x-forwarded-for` (which an attacker on a
  // non-Vercel host could spoof to bypass the per-IP rate-limit). Final
  // fallback uses a constant so unknown traffic still hits the same
  // throttle bucket instead of getting a free pass.
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (isRateLimited(ip)) {
    return new NextResponse("rate limited", { status: 429 });
  }
  const code = searchParams.get("code");
  // Phase 70: cap code length to prevent log-flood / parser abuse.
  // Supabase auth codes are typically <256 chars.
  if (code && code.length > 512) {
    return NextResponse.redirect(`${origin}/login`);
  }
  // Phase 32 (Re-Audit Auth Bug 10): use URL parser instead of ASCII regex
  // — supports next-intl unicode paths (/de/journal/übersicht) while still
  // blocking absolute URLs, CRLF injection, path-traversal, and
  // protocol-relative redirects.
  const rawNext = searchParams.get("next") ?? "/";
  function safeNext(raw: string): string {
    try {
      const u = new URL(raw, "https://placeholder.invalid");
      if (u.origin !== "https://placeholder.invalid") return "/";
      const path = u.pathname + u.search;
      if (/[\r\n\\]/.test(path)) return "/";
      if (path.startsWith("//") || path.includes("/../")) return "/";
      return path || "/";
    } catch {
      return "/";
    }
  }
  const next = safeNext(rawNext);

  if (code) {
    const supabase = await createServerSupabaseClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${origin}${next}`);
      }
    }
  }

  // If code exchange fails, redirect to login
  return NextResponse.redirect(`${origin}/login`);
}
