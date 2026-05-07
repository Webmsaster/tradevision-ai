import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { __forceClearTelegramSuppression } from "@/utils/telegramNotify";
import { isRateLimited } from "@/utils/distributedRateLimit";

/**
 * R67-r12 admin-gate hardening (security audit follow-up to r11):
 *
 *   - r11 wired this endpoint behind `requireFtmoMonitorAuth`, but that
 *     helper is read-side and fail-OPEN: if Supabase is unreachable or
 *     `FTMO_MONITOR_AUTH_BYPASS=1` is set, ANY caller passes the gate.
 *     For a destructive admin action (clearing telegram permanent-
 *     suppression mid-session) that is not acceptable.
 *   - We now require an authenticated Supabase session whose email
 *     matches `FTMO_ADMIN_EMAIL`. No env → endpoint disabled (503).
 *   - Same-origin Origin/Host check kept as defence-in-depth against
 *     cross-origin browser CSRF.
 *   - Rate-limited (5/min/IP) so even with a leaked admin cookie an
 *     attacker can't burst-clear.
 *   - Each invocation is logged with email + timestamp for post-mortem.
 */
export async function POST(request: Request) {
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (
    await isRateLimited("telegram-clear", ip, { windowMs: 60_000, maxHits: 5 })
  ) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429 },
    );
  }

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host)
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  try {
    if (new URL(origin).host !== host)
      return NextResponse.json(
        { ok: false, error: "forbidden" },
        { status: 403 },
      );
  } catch {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  const adminEmail = process.env.FTMO_ADMIN_EMAIL;
  if (!adminEmail) {
    return NextResponse.json(
      { ok: false, error: "endpoint_disabled" },
      { status: 503 },
    );
  }

  // Strict, fail-CLOSED auth — destructive endpoint must NEVER pass on
  // missing-supabase or BYPASS-flag short-circuits.
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    return NextResponse.json(
      { ok: false, error: "auth_unavailable" },
      { status: 503 },
    );
  }
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "auth_unavailable" },
      { status: 503 },
    );
  }
  let userEmail: string | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }
    userEmail = data.user.email;
  } catch {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  if (userEmail.toLowerCase() !== adminEmail.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: "forbidden" },
      { status: 403 },
    );
  }

  __forceClearTelegramSuppression();
  console.info(
    `[telegram-clear-suppression] cleared by=${userEmail} ip=${ip} ts=${new Date().toISOString()}`,
  );
  return NextResponse.json({
    ok: true,
    message: "Telegram suppression cleared",
  });
}
