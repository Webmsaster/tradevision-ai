/**
 * symbol.ts tests — canonical symbol normalisation + display formatting.
 *
 * normaliseSymbol is the single write-path normaliser (R67-RR1 fix for
 * the CSV-vs-form split); formatSymbolForDisplay re-inserts the `/`
 * before a known quote suffix for UI rendering.
 */
import { describe, expect, it } from "vitest";
import { formatSymbolForDisplay, normaliseSymbol } from "@/utils/symbol";

describe("normaliseSymbol", () => {
  it("uppercases and strips whitespace, dash, underscore and slash", () => {
    expect(normaliseSymbol("btc/usdt")).toBe("BTCUSDT");
    expect(normaliseSymbol("  BTC - USDT ")).toBe("BTCUSDT");
    expect(normaliseSymbol("eth_usd")).toBe("ETHUSD");
    expect(normaliseSymbol("SOL USDT")).toBe("SOLUSDT");
  });

  it("produces identical canonical form for CSV-style and form-style input", () => {
    // The original bug: `BTC/USDT` (manual form) vs `BTCUSDT` (CSV import)
    // fragmented AI-detector stat buckets.
    expect(normaliseSymbol("BTC/USDT")).toBe(normaliseSymbol("BTCUSDT"));
  });
});

describe("formatSymbolForDisplay", () => {
  it("re-inserts the slash before a known quote suffix", () => {
    expect(formatSymbolForDisplay("BTCUSDT")).toBe("BTC/USDT");
    expect(formatSymbolForDisplay("ETHUSD")).toBe("ETH/USD");
    expect(formatSymbolForDisplay("ADAEUR")).toBe("ADA/EUR");
    expect(formatSymbolForDisplay("SOLBTC")).toBe("SOL/BTC");
  });

  it("respects suffix priority — USDT matches before USD", () => {
    // "USDT" is listed before "USD"; a USDT pair must not split as
    // BTCUSD + T.
    expect(formatSymbolForDisplay("BTCUSDT")).toBe("BTC/USDT");
  });

  it("returns the input unchanged when no known quote suffix matches", () => {
    expect(formatSymbolForDisplay("DAX40")).toBe("DAX40");
    expect(formatSymbolForDisplay("XAUXAG")).toBe("XAUXAG");
  });

  it("does not format when the symbol IS just a quote suffix (no base left)", () => {
    expect(formatSymbolForDisplay("USDT")).toBe("USDT");
    expect(formatSymbolForDisplay("BTC")).toBe("BTC");
  });
});
