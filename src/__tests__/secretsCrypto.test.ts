import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ENC_PREFIX,
  decryptSecret,
  encryptSecret,
  getOrCreateOfflineKey,
  isCryptoAvailable,
  isEncrypted,
  resolveUserKey,
} from "@/utils/secretsCrypto";

// R67-Final: AES-GCM round-trip + format + fallback contract.
//
// Tests run under jsdom which exposes Node's WebCrypto via
// globalThis.crypto.subtle. The fallback path is exercised by
// stubbing crypto.subtle to undefined.

const SAMPLE_TG =
  "https://api.telegram.org/bot1234567890:ABCDEFghijklMNOPqrstuvwxyz/sendMessage?chat_id=12345";
const SAMPLE_DC =
  "https://discord.com/api/webhooks/123456789012345678/abcdefghij_klmnopQRSTUVWXYZ-0123456789";

describe("secretsCrypto - basic guards", () => {
  it("isCryptoAvailable() reports true under jsdom", () => {
    expect(isCryptoAvailable()).toBe(true);
  });

  it("isEncrypted() detects the envelope marker", () => {
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("https://example.com")).toBe(false);
    expect(isEncrypted(`${ENC_PREFIX}abc`)).toBe(true);
  });

  it("encrypts to the expected v1 envelope shape", async () => {
    const ct = await encryptSecret(SAMPLE_TG, "user-uuid-1");
    expect(ct.startsWith(ENC_PREFIX)).toBe(true);
    expect(ct.length).toBeGreaterThan(ENC_PREFIX.length + 32);
    // base64 only (after prefix)
    const b64 = ct.slice(ENC_PREFIX.length);
    expect(/^[A-Za-z0-9+/=]+$/.test(b64)).toBe(true);
  });

  it("encryptSecret('') / falsy returns input unchanged", async () => {
    expect(await encryptSecret("", "user")).toBe("");
  });

  it("decryptSecret() passes through plaintext (migration case)", async () => {
    const out = await decryptSecret(SAMPLE_TG, "user-uuid-1");
    expect(out).toBe(SAMPLE_TG);
  });
});

describe("secretsCrypto - round-trip", () => {
  it("decrypts back to the original plaintext (Telegram URL)", async () => {
    const userKey = "user-uuid-aaa";
    const ct = await encryptSecret(SAMPLE_TG, userKey);
    expect(ct).not.toBe(SAMPLE_TG);
    const pt = await decryptSecret(ct, userKey);
    expect(pt).toBe(SAMPLE_TG);
  });

  it("decrypts back to the original plaintext (Discord URL)", async () => {
    const userKey = "user-uuid-bbb";
    const ct = await encryptSecret(SAMPLE_DC, userKey);
    const pt = await decryptSecret(ct, userKey);
    expect(pt).toBe(SAMPLE_DC);
  });

  it("produces a different ciphertext on every encrypt (random IV+salt)", async () => {
    const userKey = "user-uuid-ccc";
    const ct1 = await encryptSecret(SAMPLE_TG, userKey);
    const ct2 = await encryptSecret(SAMPLE_TG, userKey);
    expect(ct1).not.toBe(ct2);
    // both still decrypt
    expect(await decryptSecret(ct1, userKey)).toBe(SAMPLE_TG);
    expect(await decryptSecret(ct2, userKey)).toBe(SAMPLE_TG);
  });

  it("returns '' when decrypted with a different userKey (auth-tag fail)", async () => {
    const ct = await encryptSecret(SAMPLE_TG, "user-aaa");
    const out = await decryptSecret(ct, "user-bbb");
    expect(out).toBe("");
  });

  it("returns '' when ciphertext is corrupted", async () => {
    const ct = await encryptSecret(SAMPLE_TG, "user-aaa");
    // Flip a byte in the middle of the base64 payload
    const head = ct.slice(0, ENC_PREFIX.length + 10);
    const tail = ct.slice(ENC_PREFIX.length + 11);
    const corrupted = `${head}A${tail}`;
    const out = await decryptSecret(corrupted, "user-aaa");
    expect(out).toBe("");
  });
});

describe("secretsCrypto - resolveUserKey + offline key", () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("returns the supabase user.id when authenticated", () => {
    expect(resolveUserKey("supabase-uuid-xyz")).toBe("supabase-uuid-xyz");
  });

  it("mints + persists a random offline key when unauthenticated", () => {
    const k1 = resolveUserKey(null);
    const k2 = resolveUserKey(undefined);
    expect(k1).toBeTruthy();
    expect(k1.length).toBeGreaterThanOrEqual(32);
    // Same key returned across calls (persisted)
    expect(k2).toBe(k1);
  });

  it("getOrCreateOfflineKey is stable across calls", () => {
    const a = getOrCreateOfflineKey();
    const b = getOrCreateOfflineKey();
    expect(a).toBe(b);
  });
});

describe("secretsCrypto - graceful degradation when WebCrypto missing", () => {
  // Stub crypto.subtle = undefined to simulate ancient browser / locked env.
  // We DO leave getRandomValues in place because isCryptoAvailable checks
  // both — the stub to subtle alone is sufficient.
  const originalSubtle = globalThis.crypto?.subtle;

  afterEach(() => {
    if (originalSubtle) {
      Object.defineProperty(globalThis.crypto, "subtle", {
        configurable: true,
        value: originalSubtle,
      });
    }
  });

  it("encryptSecret returns plaintext unchanged when subtle missing", async () => {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: undefined,
    });
    expect(isCryptoAvailable()).toBe(false);
    const out = await encryptSecret(SAMPLE_TG, "user");
    expect(out).toBe(SAMPLE_TG);
  });

  it("decryptSecret returns plaintext unchanged when no envelope (still safe)", async () => {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: undefined,
    });
    const out = await decryptSecret("https://plain.example", "user");
    expect(out).toBe("https://plain.example");
  });

  it("decryptSecret of an envelope returns '' when subtle missing", async () => {
    // Encrypt with subtle present, then strip subtle before decrypting.
    const ct = await encryptSecret(SAMPLE_TG, "user");
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: undefined,
    });
    const out = await decryptSecret(ct, "user");
    expect(out).toBe("");
  });
});

describe("secretsCrypto - encrypt/decrypt failure path swallows logs", () => {
  it("logs and returns plaintext when subtle.encrypt throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = globalThis.crypto.subtle.encrypt;
    // Force encrypt to reject
    Object.defineProperty(globalThis.crypto.subtle, "encrypt", {
      configurable: true,
      value: () => Promise.reject(new Error("boom")),
    });
    try {
      const out = await encryptSecret("hello", "user");
      expect(out).toBe("hello");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis.crypto.subtle, "encrypt", {
        configurable: true,
        value: orig,
      });
      errSpy.mockRestore();
    }
  });
});
