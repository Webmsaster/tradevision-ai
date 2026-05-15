/**
 * Auth gate for FTMO-monitor read-side routes — extracted from
 * `src/app/api/drift-data/route.ts` (R57 security hardening) so the same
 * guard can protect `/api/ftmo-state`, `/api/ftmo-preview`,
 * `/api/paper-state`, and any future live-state endpoints.
 *
 * Round 67 audit: the original R57 fix only landed in drift-data; the other
 * three monitor routes were left unauthed → live equity/positions/PnL
 * leaked to anyone who knew the URL. This helper consolidates the gate.
 *
 * Behavior (2026-05-16 Codex audit Bug #5 — fail-CLOSED rewrite):
 *   - `FTMO_MONITOR_AUTH_BYPASS=1`: allow (explicit operator opt-out for
 *     single-owner headless VPS).
 *   - Otherwise: REQUIRE a valid Supabase session. Any failure
 *     (`cookies()` throws, Supabase unavailable, getUser errors, no user)
 *     → deny. Previously these paths fell open, leaking live equity to
 *     anyone hitting the URL on deployments where Supabase wasn't wired.
 */
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { isPlaceholderSupabaseUrl } from "@/lib/supabase";

const bypassWarned = { logged: false };

export async function requireFtmoMonitorAuth(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (
    process.env.FTMO_MONITOR_AUTH_BYPASS === "1" ||
    process.env.FTMO_MONITOR_AUTH_BYPASS === "true"
  ) {
    if (
      !bypassWarned.logged &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      !isPlaceholderSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)
    ) {
      bypassWarned.logged = true;
      console.warn(
        "[ftmo-monitor] FTMO_MONITOR_AUTH_BYPASS=1 active WHILE Supabase is " +
          "configured — every visitor can read live equity/positions/PnL. " +
          "Disable the bypass unless this is a single-owner headless VPS.",
      );
    }
    return { ok: true, reason: "bypass" };
  }
  // 2026-05-16 Codex audit Bug #5 (NORMAL Security): fail-CLOSED. Any error
  // during auth setup → deny. Previously `createServerSupabaseClient()`
  // throwing OR returning null returned ok:true — which leaked live equity
  // / positions / PnL on any deployment where Supabase env vars weren't
  // configured. The only legitimate way to bypass auth is the explicit
  // `FTMO_MONITOR_AUTH_BYPASS=1` flag above.
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return { ok: false, reason: "auth-backend-error" };
  }
  if (!supabase) {
    return { ok: false, reason: "no-auth-backend" };
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false, reason: "auth-getuser-throw" };
  }
}
