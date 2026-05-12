/**
 * Round 29 (R19-A8 deferred close-out): client-side stub for the
 * server-side encrypted secrets vault.
 *
 * Usage pattern (caller-side fall-through):
 *
 *   const remote = await loadFromVault('webhook.url');
 *   if (remote !== null) {
 *     // server vault hit — use it
 *   } else {
 *     // fall back to existing client-side AES-GCM offline-key path
 *   }
 *
 * Why this stub returns `null` for "no vault available" instead of
 * throwing:
 *   - The settings UI must work in 3 modes:
 *       1. Supabase + SECRETS_VAULT_KEY set       → vault active
 *       2. Supabase configured, vault key missing → 503, fall back
 *       3. No Supabase at all                     → 503, fall back
 *   - All three "no vault" cases return `null` from this layer so the
 *     caller can flip to the offline-key path with one branch.
 *
 * NOT WIRED YET: settings/page.tsx + useTradeStorage.ts continue to use
 * the existing offline-key path. This module is the scaffold. Hooking
 * it up will be done in a follow-up commit once the migration has been
 * applied + SECRETS_VAULT_KEY is set on Vercel.
 */

interface VaultGetResponse {
  ok: boolean;
  items?: Array<{ key: string; value: string; updatedAt: string }>;
  error?: string;
}

interface VaultPutResponse {
  ok: boolean;
  error?: string;
}

interface VaultStatus {
  /** Vault reachable + active for this user. */
  available: boolean;
  /** Reason it's unavailable (for UI hints / log analytics). */
  reason?:
    | "no_supabase"
    | "no_vault_key"
    | "unauthorized"
    | "rate_limited"
    | "network"
    | "unknown";
}

/**
 * Probes the vault by issuing a GET. Returns:
 *   - { available: true }  if vault is active for the current user
 *   - { available: false, reason } otherwise
 *
 * The settings UI can call this once on mount to decide whether to
 * surface "stored server-side" vs "stored locally (encrypted)" copy.
 */
export async function getVaultStatus(): Promise<VaultStatus> {
  try {
    const resp = await fetch("/api/secrets", {
      method: "GET",
      // No-store so the status reflects the live env (vault key may
      // have been added/removed between visits).
      cache: "no-store",
      // Same-origin credentials so the Supabase auth cookie is sent.
      credentials: "same-origin",
    });
    if (resp.status === 503) {
      const body = (await resp.json().catch(() => ({}))) as VaultGetResponse & {
        reason?: string;
      };
      return {
        available: false,
        reason:
          body?.reason === "no_vault_key" ? "no_vault_key" : "no_supabase",
      };
    }
    if (resp.status === 401) {
      return { available: false, reason: "unauthorized" };
    }
    if (resp.status === 429) {
      return { available: false, reason: "rate_limited" };
    }
    if (!resp.ok) {
      return { available: false, reason: "unknown" };
    }
    return { available: true };
  } catch {
    return { available: false, reason: "network" };
  }
}

/**
 * Reads one secret value from the server vault.
 *
 * @returns the plaintext value, or `null` if the vault is unavailable
 *          (caller should fall back to localStorage offline-key path).
 *          Empty string is returned if the key is set but the row failed
 *          server-side decryption (caller should prompt the user to
 *          re-save).
 */
export async function loadFromVault(key: string): Promise<string | null> {
  if (typeof key !== "string" || key.length === 0) return null;
  try {
    const resp = await fetch("/api/secrets", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as VaultGetResponse;
    if (!body.ok || !Array.isArray(body.items)) return null;
    const found = body.items.find((it) => it.key === key);
    return found ? found.value : "";
  } catch {
    return null;
  }
}

/**
 * Writes one secret to the server vault.
 *
 * @returns true on success, false otherwise (caller should fall back).
 *          Note: this never returns the ciphertext or any vault detail
 *          — the API contract is opaque on purpose.
 */
export async function saveToVault(
  key: string,
  value: string,
): Promise<boolean> {
  if (typeof key !== "string" || key.length === 0) return false;
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const resp = await fetch("/api/secrets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      body: JSON.stringify({ key, value }),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as VaultPutResponse;
    return body.ok === true;
  } catch {
    return false;
  }
}

/**
 * Deletes one secret from the server vault.
 *
 * @returns true on success, false otherwise.
 */
export async function deleteFromVault(key: string): Promise<boolean> {
  if (typeof key !== "string" || key.length === 0) return false;
  try {
    const resp = await fetch(`/api/secrets?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as VaultPutResponse;
    return body.ok === true;
  } catch {
    return false;
  }
}
