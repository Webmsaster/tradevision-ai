import { describe, it, expect, vi, afterEach } from "vitest";
import { buildSignedQuery, configFromEnv } from "@/utils/binanceAccount";

describe("binanceAccount — signing", () => {
  const cfg = {
    apiKey: "test-key",
    apiSecret: "test-secret",
    testnet: true,
    recvWindow: 5000,
  };

  it("buildSignedQuery appends timestamp + signature", () => {
    const qs = buildSignedQuery({ foo: "bar" }, cfg);
    expect(qs).toMatch(/foo=bar/);
    expect(qs).toMatch(/timestamp=\d+/);
    expect(qs).toMatch(/recvWindow=5000/);
    expect(qs).toMatch(/&signature=[a-f0-9]{64}$/);
  });

  it("different params produce different signatures", () => {
    const a = buildSignedQuery({ foo: "bar" }, cfg);
    const b = buildSignedQuery({ foo: "baz" }, cfg);
    const sigA = a.split("signature=")[1];
    const sigB = b.split("signature=")[1];
    expect(sigA).not.toBe(sigB);
  });

  it("signature is deterministic given same input", () => {
    // Phase 50 (R45-TEST-1): the previous test computed the expected
    // signature directly via crypto.createHmac and only asserted its
    // length — it never invoked the SUT (`buildSignedQuery`). Now we
    // freeze Date.now() so the timestamp is stable across both calls
    // and assert that two `buildSignedQuery` invocations yield the
    // exact same query string.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const a = buildSignedQuery({ foo: "bar" }, cfg);
      const b = buildSignedQuery({ foo: "bar" }, cfg);
      expect(a).toBe(b);
      // Sanity: the signature is a 64-char hex (SHA-256 hex digest).
      const sigA = a.split("signature=")[1];
      expect(sigA).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("configFromEnv reads BINANCE_* environment variables", () => {
    const prevKey = process.env.BINANCE_API_KEY;
    const prevSecret = process.env.BINANCE_API_SECRET;
    const prevTestnet = process.env.BINANCE_TESTNET;
    process.env.BINANCE_API_KEY = "k";
    process.env.BINANCE_API_SECRET = "s";
    process.env.BINANCE_TESTNET = "1";
    const c = configFromEnv();
    expect(c.apiKey).toBe("k");
    expect(c.apiSecret).toBe("s");
    expect(c.testnet).toBe(true);
    // restore
    process.env.BINANCE_API_KEY = prevKey;
    process.env.BINANCE_API_SECRET = prevSecret;
    process.env.BINANCE_TESTNET = prevTestnet;
  });
});
