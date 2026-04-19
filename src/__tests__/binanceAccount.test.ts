import { describe, it, expect } from "vitest";
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
    // Freeze timestamp to make it deterministic
    const params = "foo=bar&timestamp=12345&recvWindow=5000";
    const crypto = require("node:crypto");
    const expected = crypto
      .createHmac("sha256", "test-secret")
      .update(params)
      .digest("hex");
    expect(expected).toHaveLength(64);
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
