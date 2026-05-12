/**
 * Round 29 (R19-A8 deferred close-out): server-side AES-GCM helper for the
 * `user_secrets` vault.
 *
 * Encryption format (base64 of binary):
 *   [ 12 bytes IV (random) | N bytes ciphertext | 16 bytes GCM auth tag ]
 *
 * Why server-side Node crypto (and NOT WebCrypto):
 *   - This module is imported only by API route handlers (`route.ts`),
 *     which run in the Node runtime by default in Next.js 15. Node's
 *     `crypto.createCipheriv('aes-256-gcm')` is well-tested, sync where
 *     useful, and avoids the WebCrypto import overhead.
 *   - The vault key is a 32-byte hex string from `process.env.SECRETS_VAULT_KEY`
 *     and never leaves the server. WebCrypto is the right fit for the
 *     client-side offline-key path (`offlineKey.ts`); not here.
 *
 * Tampering: the GCM auth tag is verified during decrypt; any bit-flip
 * in IV, ciphertext, or tag throws and the API returns a generic 400.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm" as const;
const IV_LEN = 12; // 96-bit IV is the GCM spec recommendation
const TAG_LEN = 16; // 128-bit auth tag (GCM default)
const KEY_LEN = 32; // 256-bit key
const MAX_PLAINTEXT_BYTES = 8 * 1024; // 8 KiB — webhook URLs / tokens are tiny

export class VaultDisabledError extends Error {
  constructor() {
    super(
      "Vault is disabled — set SECRETS_VAULT_KEY env (32-byte hex) on the server.",
    );
    this.name = "VaultDisabledError";
  }
}

export class VaultDecryptError extends Error {
  constructor() {
    // Generic message — never leak whether the failure was bad-tag vs
    // wrong-key vs malformed-base64; an attacker probing the API
    // shouldn't be able to distinguish.
    super("decrypt_failed");
    this.name = "VaultDecryptError";
  }
}

/**
 * Returns the 32-byte vault key, or null if not configured. Centralised
 * so callers don't accidentally read `process.env.SECRETS_VAULT_KEY`
 * from many places (one validation, one error message).
 */
export function getVaultKey(): Buffer | null {
  const hex = process.env.SECRETS_VAULT_KEY;
  if (!hex) return null;
  // Allow the operator to paste the hex with surrounding whitespace.
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  if (trimmed.length !== KEY_LEN * 2) return null;
  return Buffer.from(trimmed, "hex");
}

/**
 * @returns true if `SECRETS_VAULT_KEY` is set + valid format.
 * Used by the API route to decide between 200 (vault active) and 503
 * (client should fall back to localStorage path).
 */
export function isVaultEnabled(): boolean {
  return getVaultKey() !== null;
}

/**
 * Encrypts a plaintext UTF-8 string under the configured vault key.
 *
 * @returns base64 of [iv ‖ ciphertext ‖ tag]
 * @throws VaultDisabledError if SECRETS_VAULT_KEY is not configured.
 */
export function encryptSecret(plaintext: string): string {
  const key = getVaultKey();
  if (!key) throw new VaultDisabledError();

  if (typeof plaintext !== "string") {
    throw new Error("plaintext must be a string");
  }
  const ptBuf = Buffer.from(plaintext, "utf8");
  if (ptBuf.length === 0) {
    throw new Error("plaintext is empty");
  }
  if (ptBuf.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Sanity: GCM in Node always returns 16-byte tag, but assert in case
  // a future version ever changes the default.
  if (tag.length !== TAG_LEN) {
    throw new Error("unexpected GCM tag length");
  }
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Decrypts a base64-encoded blob produced by `encryptSecret`.
 *
 * @throws VaultDisabledError if the key is not configured.
 * @throws VaultDecryptError on any tampering / wrong-key / malformed input.
 */
export function decryptSecret(blobB64: string): string {
  const key = getVaultKey();
  if (!key) throw new VaultDisabledError();

  if (typeof blobB64 !== "string" || blobB64.length === 0) {
    throw new VaultDecryptError();
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(blobB64, "base64");
  } catch {
    throw new VaultDecryptError();
  }

  // Minimum size = IV + at least 1 byte ct + tag.
  if (raw.length < IV_LEN + 1 + TAG_LEN) {
    throw new VaultDecryptError();
  }

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);

  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Any GCM auth-tag mismatch / wrong-key / corrupt-ct lands here.
    throw new VaultDecryptError();
  }
}

// ---------------------------------------------------------------------
// Test-only helpers (constants the test file needs to assert on).
// ---------------------------------------------------------------------
export const __testInternals = {
  IV_LEN,
  TAG_LEN,
  KEY_LEN,
  MAX_PLAINTEXT_BYTES,
  // Constant-time equality wrapper used by the test for completeness.
  timingSafeStringEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  },
};
