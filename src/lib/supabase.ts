import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Create a Supabase client for use in browser/client components.
 * Returns null if environment variables are not configured,
 * allowing the app to gracefully fall back to localStorage.
 */
export async function createClient(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || url === 'https://your-project.supabase.co') {
    return null;
  }

  // Lazy-load Supabase browser client to keep initial JS payload smaller.
  const { createBrowserClient } = await import('@supabase/ssr');
  return createBrowserClient(url, key);
}
