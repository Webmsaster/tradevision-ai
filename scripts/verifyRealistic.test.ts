/**
 * Stress-tests the walk-forward strategy with REALISTIC execution:
 *   - 60% maker fill rate (Albers et al. 2025)
 *   - 3 bps adverse-selection penalty per fill
 *   - Skip funding-settle hours (00, 08, 16 UTC)
 *   - Test with and without taker fallback
 *
 * Then computes portfolio allocation over the 3 symbols as a stand-in
 * ensemble.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForwardHourOfDay } from "../src/utils/walkForward";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { allocate } from "../src/utils/portfolio";

const TAKER_COSTS = {
  takerFee: 0.0004,
  slippageBps: 2,
  fundingBpPerHour: 0.1,
};

describe("realistic execution", () => {
  it(
    "honest walk-forward with 60% fill + adverse selection",
    { timeout: 300_000 },
    async () => {
      const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      const configs = [
        {
          name: "IDEAL (100% fill, 0 adverse)",
          makerFillRate: 1.0,
          adverseSelectionBps: 0,
          fallbackToTaker: false,
          skipFundingHours: false,
        },
        {
          name: "REALISTIC (60% fill, 3bps adverse, skip funding)",
          makerFillRate: 0.6,
          adverseSelectionBps: 3,
          fallbackToTaker: false,
          skipFundingHours: true,
        },
        {
          name: "REALISTIC + taker-fallback",
          makerFillRate: 0.6,
          adverseSelectionBps: 3,
          fallbackToTaker: true,
          skipFundingHours: true,
        },
        {
          name: "PESSIMISTIC (50% fill, 5bps adverse)",
          makerFillRate: 0.5,
          adverseSelectionBps: 5,
          fallbackToTaker: false,
          skipFundingHours: true,
        },
      ];

      const strategyReturns: { name: string; returnsPct: number[] }[] = [];

      for (const sym of syms) {
        const h = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 20000,
        });
        console.log(`\n${sym}:`);
        for (const c of configs) {
          const rep = runWalkForwardHourOfDay(h, {
            trainBars: 4380,
            testBars: 720,
            topK: 3, // grid search said topK=2/3 best
            bottomK: 3,
            smaPeriodBars: 24, // grid search said sma=24 best
            longOnly: true,
            requireSignificance: false,
            costs: MAKER_COSTS,
            takerCosts: TAKER_COSTS,
            makerFillRate: c.makerFillRate,
            fallbackToTaker: c.fallbackToTaker,
            adverseSelectionBps: c.adverseSelectionBps,
            skipFundingHours: c.skipFundingHours,
          });
          console.log(
            `  ${c.name.padEnd(48)} trades=${String(rep.totalTrades).padStart(4)} ` +
              `ret=${(rep.netReturnPct * 100).toFixed(1).padStart(7)}% ` +
              `WR=${(rep.winRate * 100).toFixed(0).padStart(2)}% ` +
              `sharpe=${rep.sharpe.toFixed(2).padStart(6)} ` +
              `dd=${(rep.maxDrawdownPct * 100).toFixed(1).padStart(5)}% ` +
              `posWindows=${rep.windows.filter((w) => w.returnPct > 0).length}/${rep.windows.length}`,
          );
          // Capture REALISTIC returns for portfolio allocation
          if (c.name.startsWith("REALISTIC (")) {
            strategyReturns.push({
              name: sym,
              returnsPct: rep.allTrades.map((t) => t.netPnlPct),
            });
          }
        }
      }

      console.log("\n=== PORTFOLIO ALLOCATION (REALISTIC returns) ===");
      const alloc = allocate(
        strategyReturns.map((s) => ({
          name: s.name,
          returnsPct: s.returnsPct,
          periodsPerYear: 8760 / 2, // we don't trade every hour
        })),
      );
      console.log(
        `Portfolio std=${(alloc.portfolioStdevPct * 100).toFixed(2)}%  leverage=${alloc.leverage.toFixed(2)}  sum-exposure=${alloc.effectiveExposureSum.toFixed(2)}  gov=${alloc.ddGovernor}`,
      );
      for (const r of alloc.rows) {
        console.log(
          `  ${r.name.padEnd(10)} rawW=${r.rawWeight.toFixed(3)} corrHaircut=${r.correlationHaircut.toFixed(2)} kellyCap=${(r.kellyCap === Infinity ? 99 : r.kellyCap).toFixed(2)} finalW=${r.finalWeight.toFixed(3)} sharpe=${r.cappedSharpe.toFixed(2)}`,
        );
      }
    },
  );
});
