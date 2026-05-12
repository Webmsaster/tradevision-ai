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
    // R67-r17 audit fix (HIGH): force Secure + SameSite=Lax on Supabase
    // auth cookies in production. Default `httpOnly:false` is required for
    // PKCE refresh in browser; we don't override it. Without `secure`,
    // tokens travel over plain HTTP if a misconfigured domain serves the
    // app un-TLS'd, exposing them to network attackers.
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
  });
}
