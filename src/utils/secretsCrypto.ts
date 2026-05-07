// R67-Final (R19-A8 deferred MED): WebCrypto AES-GCM encryption-at-rest
// for Telegram bot tokens / Discord webhook URLs stored in localStorage.
//
// Threat model: an attacker with read-access to localStorage (XSS, browser
// extension, shared device) currently sees the bot token in plaintext.
// The shipped UI warning in R21 surfaces the risk to the user; this module
// adds a real defence-in-depth layer.
//
// Design:
// - AES-GCM 256-bit (auth + integrity)
// - PBKDF2-SHA-256 with 250k iterations to derive the AES key from
//   `userKey` (Supabase user.id when authenticated, or a generated random
//   browser-local key for offline mode)
// - Random 16-byte salt per encryption (prepended)
// - Random 12-byte IV per encryption (prepended)
// - Output format: `enc:v1:<base64(salt | iv | ciphertext+tag)>`
//
// IMPORTANT: this is NOT zero-knowledge. The userKey lives in either:
//   a) the Supabase JWT subject (visible to anyone who can read the
//      session cookie), or
//   b) localStorage itself (offline mode — pure obfuscation against
//      casual extensions, NO defence against full-DOM XSS).
// In both cases the goal is to raise the bar above plaintext, not to
// achieve real cryptographic secrecy. Document this in the UI.
//
// Test environment: vitest runs in jsdom which exposes Node's WebCrypto
// via globalThis.crypto.subtle. If subtle is missing for any reason we
// fall back to plain (ENC_PREFIX absent) so test runs and very-old
// browsers don't crash — only the storage layer notices.

export const ENC_PREFIX = "enc:v1:";
const PBKDF2_ITERATIONS = 250_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH_BITS = 256;
const OFFLINE_KEY_STORAGE_KEY = "tradevision-secrets-offline-key";

/** Detect whether WebCrypto AES-GCM is usable in the current environment. */
export function isCryptoAvailable(): boolean {
  try {
    return (
      typeof globalThis !== "undefined" &&
      typeof globalThis.crypto !== "undefined" &&
      typeof globalThis.crypto.subtle !== "undefined" &&
      typeof globalThis.crypto.getRandomValues === "function"
    );
  } catch {
    return false;
  }
}

/** True if `value` carries the v1 encryption envelope marker. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/**
 * Resolve a user-scoped key for PBKDF2.
 * - Authenticated: pass `user.id` from Supabase (stable, per-account).
 * - Offline / unauthenticated: pass `null` and we mint+persist a random
 *   browser-local 256-bit key in localStorage. This is pure obfuscation
 *   against casual snooping; an XSS payload reading localStorage can
 *   trivially read the key too. Documented in the settings UI warning.
 */
export function getOrCreateOfflineKey(): string {
  if (typeof window === "undefined" || !isCryptoAvailable()) {
    // Deterministic fallback so SSR / no-crypto renders stay stable.
    return "tradevision-offline-fallback-key";
  }
  try {
    const existing = window.localStorage.getItem(OFFLINE_KEY_STORAGE_KEY);
    if (existing && existing.length >= 32) return existing;
    const buf = new Uint8Array(32);
    globalThis.crypto.getRandomValues(buf);
    const fresh = bufToBase64(buf.buffer);
    window.localStorage.setItem(OFFLINE_KEY_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage disabled / quota — degrade to fallback. Encryption
    // will still work but the per-device key isn't persistent.
    return "tradevision-offline-fallback-key";
  }
}

/**
 * Resolve the effective userKey: prefer Supabase user.id when present,
 * otherwise mint/return the browser-local offline key.
 */
export function resolveUserKey(
  supabaseUserId: string | null | undefined,
): string {
  if (typeof supabaseUserId === "string" && supabaseUserId.length > 0) {
    return supabaseUserId;
  }
  return getOrCreateOfflineKey();
}

// ---- Internal helpers --------------------------------------------------

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    // Uint8Array index access returns number | undefined under TS strict
    // because of `noUncheckedIndexedAccess`; coerce — i is always in range.
    binary += String.fromCharCode(bytes[i] as number);
  }
  // btoa is available in browsers + jsdom + Node >=16
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary =
    typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Build a fresh ArrayBuffer copy from any byte input. The WebCrypto type
// definitions in newer @types/node + lib.dom.d.ts require BufferSource
// backed by an ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer); a
// plain `new Uint8Array(N)` is typed `Uint8Array<ArrayBufferLike>`,
// which fails the assignment. Returning the underlying ArrayBuffer
// directly sidesteps the variance issue and also defends against any
// accidental SharedArrayBuffer inputs reaching subtle.*.
function toArrayBuffer(src: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(src.byteLength);
  new Uint8Array(ab).set(src);
  return ab;
}

// R67-RR2-Round2 audit fix: per-process derived-key cache. PBKDF2 250k
// iterations is intentionally slow (~50-150ms per call); fireWebhook
// previously re-derived on EVERY trade event, blocking the main thread
// for 2.5-7s on a 50-trade CSV import. Cache is keyed by userKey + salt
// (base64) so different salts (= different envelopes) still re-derive
// once, then re-use. Map is module-local so a second tab gets its own
// cache (acceptable — no cross-tab security concern, just perf).
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

// Test-only: reset the cache between cases.
export const __resetDerivedKeyCacheForTests = (): void => {
  derivedKeyCache.clear();
};

function bytesToB64ForCacheKey(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.byteLength; i += 1) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

async function deriveAesKey(
  userKey: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const cacheKey = `${userKey}|${bytesToB64ForCacheKey(salt)}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const subtle = globalThis.crypto.subtle;
  const promise = (async () => {
    const baseKey = await subtle.importKey(
      "raw",
      toArrayBuffer(new TextEncoder().encode(userKey)),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    return subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: toArrayBuffer(salt),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: KEY_LENGTH_BITS },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  derivedKeyCache.set(cacheKey, promise);
  // Drop on derive-failure so retries can succeed under intermittent fault.
  promise.catch(() => derivedKeyCache.delete(cacheKey));
  return promise;
}

// ---- Public API --------------------------------------------------------

/**
 * Encrypt a plaintext secret with AES-GCM under a key derived from
 * `userKey` via PBKDF2. Returns the v1 envelope `enc:v1:<base64>`.
 *
 * If WebCrypto isn't available (very old browser / broken test env),
 * returns the plaintext unchanged so callers degrade gracefully. Use
 * `isEncrypted()` on the result to decide whether to trust it as
 * encrypted-at-rest.
 */
export async function encryptSecret(
  plaintext: string,
  userKey: string,
): Promise<string> {
  if (!plaintext) return plaintext;
  if (!isCryptoAvailable()) return plaintext;
  try {
    const salt = new Uint8Array(SALT_LENGTH);
    globalThis.crypto.getRandomValues(salt);
    const iv = new Uint8Array(IV_LENGTH);
    globalThis.crypto.getRandomValues(iv);
    const aesKey = await deriveAesKey(userKey, salt);
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(new TextEncoder().encode(plaintext)),
    );
    // Concatenate salt | iv | ciphertext+tag
    const ctBytes = new Uint8Array(ct);
    const out = new Uint8Array(salt.length + iv.length + ctBytes.length);
    out.set(salt, 0);
    out.set(iv, salt.length);
    out.set(ctBytes, salt.length + iv.length);
    return ENC_PREFIX + bufToBase64(out.buffer);
  } catch (err) {
    console.error("[secretsCrypto] encrypt failed, returning plaintext:", err);
    return plaintext;
  }
}

/**
 * Decrypt a v1 envelope produced by `encryptSecret`. If the input does
 * not have the envelope, it is returned unchanged (assumed plaintext —
 * supports the in-place migration path: existing plaintext URLs keep
 * working until the user saves, at which point they get encrypted).
 *
 * On any decryption error (wrong userKey, corrupted ciphertext, missing
 * subtle) the empty string is returned and a warning is logged. The
 * caller treats "" as "no webhook configured" which is the safest
 * default — better to silently drop than to leak a malformed URL.
 */
export async function decryptSecret(
  ciphertext: string,
  userKey: string,
): Promise<string> {
  if (!ciphertext) return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext;
  if (!isCryptoAvailable()) {
    console.warn(
      "[secretsCrypto] decrypt: WebCrypto not available — returning empty",
    );
    return "";
  }
  try {
    const b64 = ciphertext.slice(ENC_PREFIX.length);
    const buf = new Uint8Array(base64ToBuf(b64));
    if (buf.byteLength < SALT_LENGTH + IV_LENGTH + 16 /* GCM tag */) {
      throw new Error("ciphertext too short");
    }
    const salt = buf.slice(0, SALT_LENGTH);
    const iv = buf.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ct = buf.slice(SALT_LENGTH + IV_LENGTH);
    const aesKey = await deriveAesKey(userKey, salt);
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      aesKey,
      toArrayBuffer(ct),
    );
    return new TextDecoder().decode(pt);
  } catch (err) {
    console.error("[secretsCrypto] decrypt failed:", err);
    return "";
  }
}
