import { describe, it } from "vitest";
import { fetchDeribitSkew } from "../src/utils/deribitSkew";

describe("iteration 23 — Deribit skew", () => {
  it("live 25d skew snapshot", { timeout: 30_000 }, async () => {
    const s = await fetchDeribitSkew();
    console.log("\n=== DERIBIT 25-DELTA SKEW (BTC, nearest expiry) ===");
    console.log(`  Expiry: ${s.expiry}  Spot: $${s.spotEstimate.toFixed(2)}`);
    console.log(
      `  Call IV (ATM+5%): ${s.call25dIv !== null ? s.call25dIv.toFixed(2) + "%" : "—"}  Put IV (ATM-5%): ${s.put25dIv !== null ? s.put25dIv.toFixed(2) + "%" : "—"}`,
    );
    console.log(
      `  Skew: ${(s.skewPct * 100).toFixed(2)}pp  Bias: ${s.bias.toUpperCase()}  Magnitude: ${s.magnitude}`,
    );
    console.log(`  ${s.interpretation}`);
  });
});
