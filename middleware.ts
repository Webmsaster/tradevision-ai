import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Middleware to refresh the Supabase auth session on every request.
 * This keeps the session alive and ensures cookies are up to date.
 * Does NOT block unauthenticated users — the app works without login.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Skip middleware if Supabase is not configured
  if (!url || !key || url === "https://your-project.supabase.co") {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
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
