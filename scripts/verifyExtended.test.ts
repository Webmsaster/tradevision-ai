/**
 * Verifies the three extended strategies against live APIs:
 *   - Funding Carry (Binance funding)
 *   - MVRV-Z (Coinmetrics community)
 *   - BTC Dominance (CoinGecko /global)
 *
 * Run:  node ./node_modules/vitest/vitest.mjs run scripts/verifyExtended.test.ts --reporter=verbose
 */
import { describe, it } from "vitest";
import { fetchAndBacktestCarry } from "../src/utils/fundingCarry";
import { fetchMvrvHistory, runMvrvBacktest } from "../src/utils/mvrvStrategy";
import { fetchDominance, classifyDominance } from "../src/utils/btcDominance";

describe("extended strategies (live API)", () => {
  it("funding carry backtest (BTC/ETH/SOL)", { timeout: 120_000 }, async () => {
    console.log(
      "\n=== FUNDING CARRY (neutral basis, short-perp+long-spot) ===",
    );
    for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      const rep = await fetchAndBacktestCarry(sym, 2000);
      console.log(
        `  ${sym} periods=${rep.totalPeriods} inMarket=${rep.periodsInTrade} ` +
          `trades=${rep.trades.length} net=${(rep.netCarryPct * 100).toFixed(2)}% ` +
          `ann=${(rep.annualisedPct * 100).toFixed(1)}% ` +
          `dd=${(rep.maxDrawdownPct * 100).toFixed(2)}% ` +
          `funding+%=${(rep.fundingPositivePct * 100).toFixed(0)}% ` +
          `meanFR=${(rep.meanFunding * 100).toFixed(4)}%`,
      );
    }
  });

  it("MVRV-Z regime backtest (BTC)", { timeout: 60_000 }, async () => {
    console.log("\n=== MVRV-Z (BTC, Coinmetrics free community API) ===");
    const samples = await fetchMvrvHistory();
    console.log(
      `  samples=${samples.length} from ${new Date(samples[0]?.time ?? 0).toISOString().slice(0, 10)} to ${new Date(samples[samples.length - 1]?.time ?? 0).toISOString().slice(0, 10)}`,
    );
    const rep = runMvrvBacktest(samples);
    console.log(
      `  trades=${rep.trades.length} ` +
        `strategyRet=${(rep.totalReturnPct * 100).toFixed(0)}% ` +
        `buyHoldRet=${(rep.buyAndHoldPct * 100).toFixed(0)}% ` +
        `maxDD=${(rep.maxDrawdownPct * 100).toFixed(1)}% ` +
        `timeInMkt=${(rep.timeInMarketPct * 100).toFixed(0)}% ` +
        `currentZ=${rep.currentZ?.toFixed(2)} regime=${rep.currentRegime}`,
    );
    console.log(`  all ${rep.trades.length} trades:`);
    rep.trades.forEach((t) => {
      console.log(
        `    ${new Date(t.openTime).toISOString().slice(0, 10)}→` +
          `${new Date(t.closeTime).toISOString().slice(0, 10)}  ` +
          `entryMVRV=${t.entryZ.toFixed(2)} exitMVRV=${t.exitZ.toFixed(2)}  ` +
          `ret=${(t.netReturnPct * 100).toFixed(1)}%`,
      );
    });
  });

  it("BTC dominance live snapshot", { timeout: 30_000 }, async () => {
    console.log("\n=== BTC DOMINANCE (CoinGecko free /global) ===");
    const snap = await fetchDominance();
    console.log(
      `  BTC.D=${snap.btcDominancePct.toFixed(2)}%  ETH.D=${snap.ethDominancePct.toFixed(2)}%  ` +
        `totalMCap=$${(snap.totalMarketCapUsd / 1e12).toFixed(2)}T  ` +
        `24h=${snap.marketCapChange24hPct.toFixed(2)}%`,
    );
    const regime = classifyDominance(snap, true, []);
    console.log(`  bias=${regime.bias}  trend=${regime.trend}`);
    console.log(`  ${regime.interpretation}`);
  });
});
