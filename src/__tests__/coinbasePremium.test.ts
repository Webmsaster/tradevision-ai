/**
 * coinbasePremium tests.
 *
 * fetchCoinbasePremium compares Coinbase vs Binance BTC spot and grades
 * the premium into signal (bullish/bearish/neutral) × magnitude
 * (extreme/strong/moderate/noise) buckets with an interpretation string.
 *
 * The shared retry helper (fetchJsonWithRetry) is module-mocked so no
 * network is touched and no retry/backoff timing leaks into the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithRetry } from "@/utils/httpRetry";
import { fetchCoinbasePremium } from "@/utils/coinbasePremium";

vi.mock("@/utils/httpRetry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

const mockFetchJson = vi.mocked(fetchJsonWithRetry);

/** Route the two endpoint URLs to fixed prices. */
function stubPrices(coinbase: number, binance: number): void {
  mockFetchJson.mockImplementation(async (url: string) => {
    if (url.includes("coinbase")) return { price: String(coinbase) };
    if (url.includes("binance")) return { price: String(binance) };
    throw new Error(`unexpected url: ${url}`);
  });
}

beforeEach(() => {
  mockFetchJson.mockReset();
});

describe("fetchCoinbasePremium — premium math", () => {
  it("computes premiumPct as (coinbase - binance) / binance and echoes both prices", async () => {
    stubPrices(100_200, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.coinbasePriceUsd).toBe(100_200);
    expect(snap.binancePriceUsd).toBe(100_000);
    expect(snap.premiumPct).toBeCloseTo(0.002, 10);
    expect(snap.capturedAt).toBeGreaterThan(0);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it("guards against a zero Binance price (premium 0 instead of Infinity)", async () => {
    stubPrices(100_000, 0);
    const snap = await fetchCoinbasePremium();
    expect(snap.premiumPct).toBe(0);
    expect(snap.signal).toBe("neutral");
  });
});

describe("fetchCoinbasePremium — signal/magnitude buckets", () => {
  it("flat market (<0.05%) → neutral / noise", async () => {
    stubPrices(100_010, 100_000); // +0.01%
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("neutral");
    expect(snap.magnitude).toBe("noise");
    expect(snap.interpretation).toContain("no flow imbalance");
  });

  it("mild premium (+0.1%) → bullish / moderate", async () => {
    stubPrices(100_100, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bullish");
    expect(snap.magnitude).toBe("moderate");
    expect(snap.interpretation).toContain("Mild US-buyer tilt");
  });

  it("strong premium (+0.2%) → bullish / strong", async () => {
    stubPrices(100_200, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bullish");
    expect(snap.magnitude).toBe("strong");
    expect(snap.interpretation).toContain("Strong US buying");
  });

  it("extreme premium (+0.4%) → bullish / extreme", async () => {
    stubPrices(100_400, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bullish");
    expect(snap.magnitude).toBe("extreme");
    expect(snap.interpretation).toContain("EXTREME US buy pressure");
  });

  it("mild discount (-0.1%) → bearish / moderate", async () => {
    stubPrices(99_900, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bearish");
    expect(snap.magnitude).toBe("moderate");
    expect(snap.interpretation).toContain("Mild US-seller tilt");
  });

  it("strong discount (-0.2%) → bearish / strong", async () => {
    stubPrices(99_800, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bearish");
    expect(snap.magnitude).toBe("strong");
    expect(snap.interpretation).toContain("Strong US selling");
  });

  it("extreme discount (-0.4%) → bearish / extreme (pre-dump warning)", async () => {
    stubPrices(99_600, 100_000);
    const snap = await fetchCoinbasePremium();
    expect(snap.signal).toBe("bearish");
    expect(snap.magnitude).toBe("extreme");
    expect(snap.interpretation).toContain("pre-dump warning");
  });
});

describe("fetchCoinbasePremium — error propagation", () => {
  it("rejects when either upstream fetch fails (retry helper exhausted)", async () => {
    mockFetchJson.mockRejectedValue(new Error("upstream 503"));
    await expect(fetchCoinbasePremium()).rejects.toThrow("upstream 503");
  });
});
