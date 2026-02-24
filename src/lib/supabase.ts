import { createBrowserClient } from '@supabase/ssr';

/**
 * Create a Supabase client for use in browser/client components.
 * Returns null if environment variables are not configured,
 * allowing the app to gracefully fall back to localStorage.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || url === 'https://your-project.supabase.co') {
    return null;
  }

  return createBrowserClient(url, key);
}
