import { describe, it } from "vitest";
import {
  fetchHyperliquidFunding,
  compareCexHl,
} from "../src/utils/hyperliquidFunding";
import { fetchFundingHistory } from "../src/utils/fundingRate";

describe("iteration 28 — Hyperliquid perp funding vs Binance CEX", () => {
  it(
    "live DEX-vs-CEX funding spread snapshot",
    { timeout: 30_000 },
    async () => {
      const hl = await fetchHyperliquidFunding();
      console.log("\n=== HYPERLIQUID PERP FUNDING (live) ===");
      for (const key of ["btc", "eth", "sol"] as const) {
        const a = hl[key];
        if (!a) continue;
        console.log(
          `  ${a.symbol}: ${(a.funding8hEq * 100).toFixed(4)}%/8h | OI=${a.openInterest.toFixed(0)} | premium=${(a.premium * 100).toFixed(4)}%`,
        );
      }

      // Binance most-recent funding per symbol
      const cexBySym: Record<string, number> = {};
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const hist = await fetchFundingHistory(sym, 5);
        const last = hist[hist.length - 1];
        cexBySym[sym] = last?.fundingRate ?? 0;
      }

      console.log("\n=== DEX-CEX SPREAD ===");
      const spreads = compareCexHl(hl, cexBySym);
      for (const s of spreads) {
        console.log(
          `  ${s.symbol}: HL=${(s.hlFunding8hEq * 100).toFixed(4)}%/8h  CEX=${(s.cexFunding8h * 100).toFixed(4)}%/8h  Δ=${(s.spread * 10000).toFixed(1)}bp  [${s.magnitude}/${s.divergence}]`,
        );
        console.log(`    → ${s.interpretation}`);
      }
    },
  );
});
