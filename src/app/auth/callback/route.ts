import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

/**
 * Auth callback handler for Supabase email confirmation and OAuth redirects.
 * After confirming their email, users are redirected here, and we exchange
 * the auth code for a session.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
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
