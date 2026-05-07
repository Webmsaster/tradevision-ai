/**
 * Round 29 (R19-A8 deferred close-out): server-side encrypted secrets vault API.
 *
 * Endpoints:
 *   GET    /api/secrets          → list current user's keys + decrypted values
 *   PUT    /api/secrets          → upsert one key/value pair
 *   DELETE /api/secrets?key=...  → remove one key
 *
 * Security model:
 *   - Requires an authenticated Supabase session. RLS additionally
 *     enforces user_id = auth.uid() at the row level (defence-in-depth).
 *   - Encryption key (`SECRETS_VAULT_KEY`) lives only in the server env;
 *     ciphertext-at-rest is useless to a DB-only attacker.
 *   - Rate-limited per IP via the shared distributedRateLimit primitive:
 *       PUT/DELETE: 10/min/IP   (write path; tighter)
 *       GET:        30/min/IP   (read path; UI may poll on settings open)
 *   - Same-origin gate on PUT/DELETE: `origin.host === host` so a third-
 *     party page cannot CSRF-write a victim's vault even if the cookie
 *     is sent.
 *   - Falls back to 503 (Service Unavailable) when:
 *       * Supabase is not configured → caller uses client-side offline-key.
 *       * SECRETS_VAULT_KEY is not set → vault disabled, same fallback.
 *
 * NOT wired into the settings UI yet — that lands in a follow-up commit.
 * This is the scaffold (DB + API + crypto helper + tests).
 */
import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { isRateLimited } from "@/utils/distributedRateLimit";
import {
  decryptSecret,
  encryptSecret,
  isVaultEnabled,
  VaultDecryptError,
} from "@/lib/serverSecretsCrypto";

// Force the Node runtime — `node:crypto` createCipheriv is not in the
// Edge runtime's WebCrypto-only surface.
export const runtime = "nodejs";

const KEY_MAX_LEN = 64;
const VALUE_MAX_LEN = 8 * 1024; // 8 KiB — webhook URLs / tokens are tiny

/** Generic JSON helper with no-store cache hint. */
function json(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return NextResponse.json(body, { ...init, headers });
}

/** Extract the requesting IP, preferring un-spoofable Vercel headers. */
function getClientIp(request: Request): string {
  return (
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Same-origin gate: 403 if origin.host ≠ host. Used for write methods. */
function checkSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  try {
    if (new URL(origin).host !== host) {
      return json({ ok: false, error: "forbidden" }, { status: 403 });
    }
  } catch {
    return json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * Resolves the authenticated Supabase client + user. Returns:
 *   - { client, user }        on success
 *   - NextResponse (4xx/5xx)  on auth/config failure (caller returns it)
 */
async function authedClient(): Promise<
  | {
      client: NonNullable<
        Awaited<ReturnType<typeof createServerSupabaseClient>>
      >;
      userId: string;
    }
  | NextResponse
> {
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    // Cookies API unavailable in the runtime — treat as no-auth-backend
    // so the client falls back to the offline-key path.
    return json(
      { ok: false, error: "vault_unavailable", reason: "no_supabase" },
      { status: 503 },
    );
  }
  if (!supabase) {
    return json(
      { ok: false, error: "vault_unavailable", reason: "no_supabase" },
      { status: 503 },
    );
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return { client: supabase, userId: data.user.id };
  } catch {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
}

// ---------------------------------------------------------------------
// GET — list current user's secrets.
// ---------------------------------------------------------------------
export async function GET(request: Request): Promise<NextResponse> {
  const ip = getClientIp(request);
  if (
    await isRateLimited("secrets-get", ip, { windowMs: 60_000, maxHits: 30 })
  ) {
    return json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const auth = await authedClient();
  if (auth instanceof NextResponse) return auth;

  if (!isVaultEnabled()) {
    return json(
      { ok: false, error: "vault_unavailable", reason: "no_vault_key" },
      { status: 503 },
    );
  }

  const { client, userId } = auth;
  const { data, error } = await client
    .from("user_secrets")
    .select("key, value, updated_at")
    .eq("user_id", userId);
  if (error) {
    console.error("[secrets][GET] supabase error:", error.message);
    return json({ ok: false, error: "db_error" }, { status: 500 });
  }

  // Decrypt server-side; the client receives plaintext over the
  // same-origin TLS session. Skip rows that fail to decrypt rather
  // than fail the whole request — a corrupt row should not lock the UI.
  const items: Array<{ key: string; value: string; updatedAt: string }> = [];
  for (const row of data ?? []) {
    try {
      items.push({
        key: row.key,
        value: decryptSecret(row.value),
        updatedAt: row.updated_at,
      });
    } catch {
      // Surface a placeholder so the UI can show "decrypt failed —
      // re-save" instead of silently dropping the key.
      items.push({
        key: row.key,
        value: "",
        updatedAt: row.updated_at,
      });
    }
  }

  return json({ ok: true, items });
}

// ---------------------------------------------------------------------
// PUT — upsert one secret. Body: { key: string, value: string }.
// ---------------------------------------------------------------------
export async function PUT(request: Request): Promise<NextResponse> {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;

  const ip = getClientIp(request);
  if (
    await isRateLimited("secrets-put", ip, { windowMs: 60_000, maxHits: 10 })
  ) {
    return json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const auth = await authedClient();
  if (auth instanceof NextResponse) return auth;

  if (!isVaultEnabled()) {
    return json(
      { ok: false, error: "vault_unavailable", reason: "no_vault_key" },
      { status: 503 },
    );
  }

  let body: { key?: unknown; value?: unknown };
  try {
    body = (await request.json()) as { key?: unknown; value?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const value = typeof body?.value === "string" ? body.value : "";
  if (!key || key.length > KEY_MAX_LEN) {
    return json({ ok: false, error: "invalid_key" }, { status: 400 });
  }
  if (!value || value.length > VALUE_MAX_LEN) {
    return json({ ok: false, error: "invalid_value" }, { status: 400 });
  }

  let ciphertext: string;
  try {
    ciphertext = encryptSecret(value);
  } catch (err) {
    console.error("[secrets][PUT] encrypt failed:", err);
    return json({ ok: false, error: "encrypt_failed" }, { status: 500 });
  }

  const { client, userId } = auth;
  const { error } = await client.from("user_secrets").upsert(
    {
      user_id: userId,
      key,
      value: ciphertext,
    },
    { onConflict: "user_id,key" },
  );
  if (error) {
    console.error("[secrets][PUT] supabase error:", error.message);
    return json({ ok: false, error: "db_error" }, { status: 500 });
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------
// DELETE — remove one secret. Query: ?key=<name>.
// ---------------------------------------------------------------------
export async function DELETE(request: Request): Promise<NextResponse> {
  const csrf = checkSameOrigin(request);
  if (csrf) return csrf;

  const ip = getClientIp(request);
  if (
    await isRateLimited("secrets-put", ip, { windowMs: 60_000, maxHits: 10 })
  ) {
    return json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const auth = await authedClient();
  if (auth instanceof NextResponse) return auth;

  let key: string;
  try {
    key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  } catch {
    return json({ ok: false, error: "invalid_url" }, { status: 400 });
  }
  if (!key || key.length > KEY_MAX_LEN) {
    return json({ ok: false, error: "invalid_key" }, { status: 400 });
  }

  const { client, userId } = auth;
  const { error } = await client
    .from("user_secrets")
    .delete()
    .eq("user_id", userId)
    .eq("key", key);
  if (error) {
    console.error("[secrets][DELETE] supabase error:", error.message);
    return json({ ok: false, error: "db_error" }, { status: 500 });
  }

  return json({ ok: true });
}

// Translate VaultDecryptError to a generic 400 if it ever escapes.
// (Currently caught inside GET; this is belt-and-braces for future
// callers that forget to handle it.)
export function _isVaultDecryptError(err: unknown): boolean {
  return err instanceof VaultDecryptError;
}
