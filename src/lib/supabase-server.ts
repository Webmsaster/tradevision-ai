import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { isPlaceholderSupabaseUrl } from "./supabase";

/**
 * Create a Supabase client for use in server components and route handlers.
 * Returns null if environment variables are not configured.
 */
export async function createServerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!key || isPlaceholderSupabaseUrl(url)) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(url!, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // setAll can fail in Server Components where cookies are read-only.
          // This is expected and can be safely ignored when using middleware.
        }
      },
    },
  });
}
