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
 * Behavior:
 *   - `FTMO_MONITOR_AUTH_BYPASS=1` (or `true`): allow + once-per-process
 *     warning if Supabase IS configured (misconfiguration tell).
 *   - Supabase unavailable / `cookies()` throws: allow (localStorage-only
 *     deployments have no auth backend to enforce).
 *   - Otherwise: require `auth.getUser()` to return a session user.
 */
import { createServerSupabaseClient } from "@/lib/supabase-server";

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
      process.env.NEXT_PUBLIC_SUPABASE_URL !==
        "https://your-project.supabase.co"
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
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return { ok: true, reason: "no-auth-backend" };
  }
  if (!supabase) {
    return { ok: true, reason: "no-auth-backend" };
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
