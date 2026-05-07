/**
 * Round 29 (R19-A8 deferred close-out): tests for the server-side AES-GCM
 * vault crypto helper.
 *
 * Coverage:
 *   - Round-trip: encrypt → decrypt yields original plaintext.
 *   - Distinct ciphertexts: random IV per call → no deterministic leak.
 *   - Tampered ciphertext rejected (GCM auth-tag mismatch).
 *   - Tampered IV rejected.
 *   - Tampered tag rejected.
 *   - Truncated blob rejected.
 *   - Garbage base64 rejected.
 *   - Wrong key rejected.
 *   - Vault disabled when SECRETS_VAULT_KEY missing or malformed.
 *   - Empty / oversized plaintext rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  getVaultKey,
  isVaultEnabled,
  VaultDecryptError,
  VaultDisabledError,
  __testInternals,
} from "../lib/serverSecretsCrypto";

const ORIG_KEY = process.env.SECRETS_VAULT_KEY;

function setKey(hex: string | undefined): void {
  if (hex === undefined) delete process.env.SECRETS_VAULT_KEY;
  else process.env.SECRETS_VAULT_KEY = hex;
}

const SAMPLE_KEY = "00".repeat(__testInternals.KEY_LEN); // 32-byte zero key
const ALT_KEY = "ff".repeat(__testInternals.KEY_LEN);

describe("serverSecretsCrypto — vault key handling", () => {
  afterEach(() => {
    setKey(ORIG_KEY);
  });

  it("returns null when SECRETS_VAULT_KEY is missing", () => {
    setKey(undefined);
    expect(getVaultKey()).toBeNull();
    expect(isVaultEnabled()).toBe(false);
  });

  it("returns null when key is the wrong length", () => {
    setKey("aa".repeat(16)); // 16 bytes = AES-128, not 256
    expect(getVaultKey()).toBeNull();
    expect(isVaultEnabled()).toBe(false);
  });

  it("returns null when key contains non-hex characters", () => {
    setKey("zz".repeat(__testInternals.KEY_LEN));
    expect(getVaultKey()).toBeNull();
    expect(isVaultEnabled()).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    setKey(`  ${SAMPLE_KEY}\n`);
    expect(getVaultKey()).not.toBeNull();
    expect(isVaultEnabled()).toBe(true);
  });

  it("encryptSecret throws VaultDisabledError when key missing", () => {
    setKey(undefined);
    expect(() => encryptSecret("hello")).toThrow(VaultDisabledError);
  });

  it("decryptSecret throws VaultDisabledError when key missing", () => {
    setKey(undefined);
    expect(() => decryptSecret("AAAA")).toThrow(VaultDisabledError);
  });
});

describe("serverSecretsCrypto — encrypt/decrypt round-trip", () => {
  beforeEach(() => {
    setKey(SAMPLE_KEY);
  });
  afterEach(() => {
    setKey(ORIG_KEY);
  });

  it("round-trips ASCII plaintext", () => {
    const plain = "https://api.telegram.org/bot12345:abcdefghij/sendMessage";
    const ct = encryptSecret(plain);
    expect(decryptSecret(ct)).toBe(plain);
  });

  it("round-trips multi-byte UTF-8 plaintext", () => {
    const plain = "Glück ✓ — 漢字 — 🌑🔚";
    const ct = encryptSecret(plain);
    expect(decryptSecret(ct)).toBe(plain);
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    const plain = "same input";
    const a = encryptSecret(plain);
    const b = encryptSecret(plain);
    expect(a).not.toBe(b);
    // But both still decrypt to the same value.
    expect(decryptSecret(a)).toBe(plain);
    expect(decryptSecret(b)).toBe(plain);
  });

  it("ciphertext blob has the expected layout (iv + ct + tag)", () => {
    const plain = "x".repeat(20);
    const ct = encryptSecret(plain);
    const buf = Buffer.from(ct, "base64");
    // 12 (iv) + 20 (ct) + 16 (tag) = 48 bytes
    expect(buf.length).toBe(
      __testInternals.IV_LEN + 20 + __testInternals.TAG_LEN,
    );
  });

  it("rejects empty plaintext", () => {
    expect(() => encryptSecret("")).toThrow(/empty/);
  });

  it("rejects oversized plaintext", () => {
    const big = "a".repeat(__testInternals.MAX_PLAINTEXT_BYTES + 1);
    expect(() => encryptSecret(big)).toThrow(/exceeds/);
  });

  it("encrypts up to the cap exactly", () => {
    const exact = "a".repeat(__testInternals.MAX_PLAINTEXT_BYTES);
    const ct = encryptSecret(exact);
    expect(decryptSecret(ct)).toBe(exact);
  });
});

describe("serverSecretsCrypto — tamper rejection", () => {
  beforeEach(() => {
    setKey(SAMPLE_KEY);
  });
  afterEach(() => {
    setKey(ORIG_KEY);
  });

  function flipByte(blob64: string, idx: number): string {
    const buf = Buffer.from(blob64, "base64");
    buf[idx] = (buf[idx]! ^ 0x01) & 0xff;
    return buf.toString("base64");
  }

  it("rejects a flipped byte in the ciphertext", () => {
    const ct = encryptSecret("token-here");
    // Index inside the ciphertext region (after IV, before tag).
    const tampered = flipByte(ct, __testInternals.IV_LEN + 2);
    expect(() => decryptSecret(tampered)).toThrow(VaultDecryptError);
  });

  it("rejects a flipped byte in the IV", () => {
    const ct = encryptSecret("token-here");
    const tampered = flipByte(ct, 0);
    expect(() => decryptSecret(tampered)).toThrow(VaultDecryptError);
  });

  it("rejects a flipped byte in the auth tag", () => {
    const ct = encryptSecret("token-here");
    const buf = Buffer.from(ct, "base64");
    const tagOffset = buf.length - 1; // last byte = inside tag
    const tampered = flipByte(ct, tagOffset);
    expect(() => decryptSecret(tampered)).toThrow(VaultDecryptError);
  });

  it("rejects a truncated blob (smaller than IV+1+tag)", () => {
    // Blob too short to even contain IV + tag.
    const tooShort = randomBytes(10).toString("base64");
    expect(() => decryptSecret(tooShort)).toThrow(VaultDecryptError);
  });

  it("rejects an empty blob", () => {
    expect(() => decryptSecret("")).toThrow(VaultDecryptError);
  });

  it("rejects garbage that decodes but is not valid GCM", () => {
    // 12 IV + 16 ct + 16 tag, all zeros. Tag will fail verification.
    const garbage = Buffer.alloc(
      __testInternals.IV_LEN + 16 + __testInternals.TAG_LEN,
      0,
    ).toString("base64");
    expect(() => decryptSecret(garbage)).toThrow(VaultDecryptError);
  });

  it("rejects when decrypted with a different key", () => {
    const plain = "wrong-key-target";
    setKey(SAMPLE_KEY);
    const ct = encryptSecret(plain);
    setKey(ALT_KEY);
    expect(() => decryptSecret(ct)).toThrow(VaultDecryptError);
  });
});

describe("serverSecretsCrypto — utility helpers", () => {
  it("timingSafeStringEqual handles equal + unequal + length-mismatch", () => {
    const eq = __testInternals.timingSafeStringEqual;
    expect(eq("abc", "abc")).toBe(true);
    expect(eq("abc", "abd")).toBe(false);
    expect(eq("abc", "abcd")).toBe(false);
    expect(eq("", "")).toBe(true);
  });
});
