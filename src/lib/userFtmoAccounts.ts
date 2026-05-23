/**
 * Multi-tenant user → FTMO state-dir mapping.
 *
 * This is the SECOND chance for slug-auth in `/api/drift-data` after the
 * admin-email FAST path (`FTMO_ADMIN_EMAIL`). On a single-owner VPS this
 * helper is never reached — admin sees all slugs and the table can be empty
 * (or the migration unapplied). On a multi-tenant SaaS deploy, each user
 * gets one or more rows in `user_ftmo_accounts` mapping them to the slugs
 * they're allowed to read.
 *
 * RLS guarantees `auth.uid() = user_id`, so a request from user A asking
 * "is slug X allowed for me?" can only ever read user A's rows. The helper
 * here just runs SELECT and trusts the database to enforce isolation.
 *
 * The table may not exist (migration R29 not applied yet). In that case the
 * query throws / returns a 42P01 (`relation … does not exist`) and the helper
 * fails CLOSED — non-admin users get 403, single-owner VPS keeps working via
 * the admin-email FAST path. This matches the rest of the codebase's "graceful
 * degrade if DB feature missing" pattern (cf. soft-delete in storage.ts).
 *
 * R29 (2026-05-07).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Mirrors the slug whitelist in `src/app/api/drift-data/route.ts` so this
 * helper can defensively reject malformed slugs before going to the DB.
 * Belt-and-suspenders: the DB CHECK constraint enforces the same regex, but
 * rejecting client-side avoids a wasted round-trip.
 *
 * 2026-05-24 Wave4 HIGH FIX (Agent 4): prior regex `/^[a-z0-9][a-z0-9-]{0,63}$/`
 * (lowercase + dash only) silently rejected slugs that the upstream
 * `/api/drift-data` route accepts (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` —
 * uppercase + underscore allowed). Multi-tenant slugs like
 * `Account_A_2h-trend-amber` passed drift-data's gate but failed here, so
 * `getAllowedSlugsForUser()` returned `[]` and downstream callers got
 * 403/empty data when they shouldn't. Aligned to drift-data exactly.
 */
const TF_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Read every slug the given user is mapped to. Returns `[]` when:
 *   - userId is empty/falsy (defensive — caller should have already
 *     short-circuited but we don't trust the upstream),
 *   - the SELECT errors for any reason (table missing, network, etc.) —
 *     fail-closed: no slugs allowed,
 *   - no rows exist for the user.
 *
 * Never throws.
 */
export async function getAllowedSlugsForUser(
  userId: string,
  supabase: SupabaseClient,
): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("user_ftmo_accounts")
      .select("tf_slug")
      .eq("user_id", userId);
    if (error || !data) return [];
    const out: string[] = [];
    for (const row of data as Array<{ tf_slug?: unknown }>) {
      const slug = typeof row.tf_slug === "string" ? row.tf_slug : null;
      if (slug && TF_SLUG_RE.test(slug)) out.push(slug);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Cheap single-slug membership check. Uses `.eq("tf_slug", slug)` so the
 * DB returns at most one row (PK is (user_id, tf_slug)). Slug is regex-
 * validated before the query so a malformed input fails fast without an
 * extra round-trip.
 *
 * Returns `false` on any error (RLS denial, missing table, network) —
 * fail-closed.
 */
export async function canUserReadSlug(
  userId: string,
  slug: string,
  supabase: SupabaseClient,
): Promise<boolean> {
  if (!userId) return false;
  if (!slug || !TF_SLUG_RE.test(slug)) return false;
  try {
    const { data, error } = await supabase
      .from("user_ftmo_accounts")
      .select("tf_slug")
      .eq("user_id", userId)
      .eq("tf_slug", slug)
      .limit(1);
    if (error || !data) return false;
    return data.length > 0;
  } catch {
    return false;
  }
}
