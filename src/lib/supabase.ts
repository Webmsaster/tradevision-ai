import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Returns true if the URL is missing or matches a known placeholder.
 * Shared with `supabase-server.ts` to keep placeholder rejection consistent.
 */
export function isPlaceholderSupabaseUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url === "https://your-project.supabase.co" ||
    url === "https://placeholder.supabase.co"
  );
}

// Module-level cache so repeated `createClient()` calls in browser components
// reuse one BrowserClient instead of allocating a new one each time. The
// `undefined` sentinel preserves the null fallback path (env vars missing).
let cached: SupabaseClient | null | undefined;

/**
 * Create a Supabase client for use in browser/client components.
 * Returns null if environment variables are not configured,
 * allowing the app to gracefully fall back to localStorage.
 */
export async function createClient(): Promise<SupabaseClient | null> {
  if (cached !== undefined) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!key || isPlaceholderSupabaseUrl(url)) {
    cached = null;
    return cached;
  }

  // Lazy-load Supabase browser client to keep initial JS payload smaller.
  const { createBrowserClient } = await import("@supabase/ssr");
  cached = createBrowserClient(url!, key);
  return cached;
}

/**
 * Test-only: reset the cached client. Not exported through any barrel and
 * never imported by application code.
 */
export function __resetSupabaseClientForTests(): void {
  cached = undefined;
}
