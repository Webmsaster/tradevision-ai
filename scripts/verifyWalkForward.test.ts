/**
 * Verifies the walk-forward rolling retrain engine, grid-searches the
 * parameters that produce the most ROBUST Sharpe across windows.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  runWalkForwardHourOfDay,
  runGridSearch,
} from "../src/utils/walkForward";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("walk-forward rolling retrain (live Binance)", () => {
  it("baseline comparison", { timeout: 300_000 }, async () => {
    const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    console.log("\n=== WALK-FORWARD ROLLING RETRAIN (train 6m, test 1m) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const rep = runWalkForwardHourOfDay(h, {
        trainBars: 4380,
        testBars: 720,
        topK: 5,
        bottomK: 5,
        smaPeriodBars: 50,
        longOnly: true,
        costs: MAKER_COSTS,
        makerFillRate: 1.0,
        fallbackToTaker: false,
        requireSignificance: false,
      });
      console.log(
        `${sym}: windows=${rep.windows.length} trades=${rep.totalTrades} ` +
          `ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% ` +
          `sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
      const posWins = rep.windows.filter((w) => w.returnPct > 0).length;
      console.log(
        `  positive windows: ${posWins}/${rep.windows.length}  avg per-window sharpe: ${(rep.windows.reduce((s, w) => s + w.sharpe, 0) / rep.windows.length).toFixed(2)}`,
      );
    }

    console.log("\n=== WITH 80% MAKER FILL RATE (realistic) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const rep = runWalkForwardHourOfDay(h, {
        trainBars: 4380,
        testBars: 720,
        topK: 5,
        bottomK: 5,
        smaPeriodBars: 50,
        longOnly: true,
        costs: MAKER_COSTS,
        makerFillRate: 0.8,
        fallbackToTaker: false,
        requireSignificance: false,
      });
      console.log(
        `${sym}: trades=${rep.totalTrades} filled=${rep.filledTrades} ret=${(rep.netReturnPct * 100).toFixed(1)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    console.log("\n=== WITH TAKER FALLBACK (guaranteed fill, higher cost) ===");
    for (const sym of syms) {
      const h = await loadBinanceHistory({
        symbol: sym,
        timeframe: "1h",
        targetCount: 20000,
      });
      const rep = runWalkForwardHourOfDay(h, {
        trainBars: 4380,
        testBars: 720,
        topK: 5,
        bottomK: 5,
        smaPeriodBars: 50,
        longOnly: true,
        costs: MAKER_COSTS,
        makerFillRate: 0.8,
        fallbackToTaker: true,
        takerCosts: {
          takerFee: 0.0004,
          slippageBps: 2,
          fundingBpPerHour: 0.1,
        },
        requireSignificance: false,
      });
      console.log(
        `${sym}: trades=${rep.totalTrades} maker=${rep.filledTrades} takerFallbacks=${rep.takerFallbacks} ret=${(rep.netReturnPct * 100).toFixed(1)}% sharpe=${rep.sharpe.toFixed(2)} dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }
  });

  it(
    "grid search — find robust params per symbol",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== GRID SEARCH ===");
      const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      for (const sym of syms) {
        const h = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 20000,
        });
        const results = runGridSearch(h, sym, MAKER_COSTS, {
          trainBarsOpts: [2160, 4380, 8760], // 3m, 6m, 12m
          testBarsOpts: [168, 720, 2160], // 7d, 30d, 90d
          topKOpts: [2, 3, 5],
          smaPeriodOpts: [24, 50, 100, 200],
          longOnlyOpts: [true, false],
          fillRateOpts: [1.0],
        });
        console.log(`\n${sym} top-5 configs by Sharpe:`);
        for (const r of results.slice(0, 5)) {
          const c = r.config;
          console.log(
            `  trainBars=${c.trainBars} testBars=${c.testBars} topK=${c.topK} sma=${c.smaPeriodBars} longOnly=${c.longOnly}  → ` +
              `trades=${r.report.totalTrades} ret=${(r.report.netReturnPct * 100).toFixed(1)}% sharpe=${r.report.sharpe.toFixed(2)} dd=${(r.report.maxDrawdownPct * 100).toFixed(1)}%`,
          );
        }
      }
    },
  );
});
