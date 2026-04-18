import { describe, it } from "vitest";
import { fetchCoinbasePremium } from "../src/utils/coinbasePremium";

describe("iteration 12 — Coinbase Premium", () => {
  it("live premium snapshot", { timeout: 30_000 }, async () => {
    const snap = await fetchCoinbasePremium();
    console.log("\n=== COINBASE PREMIUM (BTC) ===");
    console.log(
      `  Coinbase: $${snap.coinbasePriceUsd.toFixed(2)}  Binance: $${snap.binancePriceUsd.toFixed(2)}`,
    );
    console.log(
      `  Premium: ${(snap.premiumPct * 100).toFixed(4)}%  Signal: ${snap.signal.toUpperCase()}  Magnitude: ${snap.magnitude}`,
    );
    console.log(`  Interpretation: ${snap.interpretation}`);
  });
});
