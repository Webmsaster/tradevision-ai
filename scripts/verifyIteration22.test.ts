import { describe, it } from "vitest";
import { fetchBybitBasis } from "../src/utils/bybitBasis";

describe("iteration 22 — Bybit basis", () => {
  it("live snapshot", { timeout: 30_000 }, async () => {
    const snap = await fetchBybitBasis();
    console.log("\n=== BYBIT BASIS (BTCUSDT spot vs perp) ===");
    console.log(
      `  Spot: $${snap.spotPriceUsdt.toFixed(2)}  Perp: $${snap.perpPriceUsdt.toFixed(2)}`,
    );
    console.log(
      `  Basis: ${(snap.basisPct * 100).toFixed(4)}%  Signal: ${snap.signal.toUpperCase()}  Magnitude: ${snap.magnitude}`,
    );
    console.log(`  ${snap.interpretation}`);
  });
});
