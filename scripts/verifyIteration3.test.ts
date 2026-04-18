/**
 * Iteration 3 verification:
 *   1. Ensemble equity curve (Champion + Monday + Funding, realistic costs)
 *   2. Vol-regime filter applied to Champion
 *   3. Deflated Sharpe on each strategy
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import {
  classifyVolRegime,
  DEFAULT_VOL_REGIME_CONFIG,
} from "../src/utils/volRegimeFilter";
import { runWalkForwardHourOfDay } from "../src/utils/walkForward";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { computeDeflatedSharpe } from "../src/utils/deflatedSharpe";

const TAKER_COSTS = {
  takerFee: 0.0004,
  slippageBps: 2,
  fundingBpPerHour: 0.1,
};

describe("iteration 3", () => {
  it(
    "ensemble equity + vol-regime + deflated sharpe",
    { timeout: 360_000 },
    async () => {
      const syms = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      const candlesByH: Record<
        string,
        Awaited<ReturnType<typeof loadBinanceHistory>>
      > = {};
      const fundingBySymbol: Record<
        string,
        Awaited<ReturnType<typeof fetchFundingHistory>>
      > = {};
      for (const sym of syms) {
        candlesByH[sym] = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 20000,
        });
        fundingBySymbol[sym] = await fetchFundingHistory(sym, 3000);
      }

      console.log("\n=== ENSEMBLE EQUITY (realistic costs) ===");
      const ens = await buildEnsembleEquity({
        candlesByH,
        fundingBySymbol,
        makerCosts: MAKER_COSTS,
        takerCosts: TAKER_COSTS,
      });
      console.log(
        `Strategies included: ${ens.strategies.length}  trades aggregated: ${ens.totalTrades}`,
      );
      for (const s of ens.strategies) {
        console.log(
          `  ${s.name.padEnd(22)}  n=${String(s.returns.length).padStart(4)}  ` +
            `mean_ann=${(s.meanPct * 100).toFixed(1).padStart(7)}%  ` +
            `std_ann=${(s.stdDevPct * 100).toFixed(1).padStart(6)}%  ` +
            `sharpe=${s.sharpe.toFixed(2).padStart(6)}  weight=${(s.weight * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `\nPORTFOLIO: ret=${(ens.totalReturnPct * 100).toFixed(1)}%  ann=${(ens.annualisedReturnPct * 100).toFixed(1)}%  vol=${(ens.annualisedVolPct * 100).toFixed(1)}%  sharpe=${ens.sharpe.toFixed(2)}  maxDD=${(ens.maxDrawdownPct * 100).toFixed(1)}%  WR=${(ens.winRate * 100).toFixed(0)}%  days=${ens.dailyReturns.length}`,
      );

      console.log("\n=== VOL-REGIME FILTER (30-70 percentile gate) ===");
      for (const sym of syms) {
        const candles = candlesByH[sym];
        const regime = classifyVolRegime(candles);
        const inReg = regime.filter((r) => r.inRegime).length;
        console.log(
          `${sym}: bars=${candles.length}  in-regime=${inReg} (${((inReg / candles.length) * 100).toFixed(1)}%)`,
        );

        // Baseline (no filter)
        const baseline = runWalkForwardHourOfDay(candles, {
          trainBars: 4380,
          testBars: 720,
          topK: 3,
          bottomK: 3,
          smaPeriodBars: 24,
          longOnly: true,
          costs: MAKER_COSTS,
          makerFillRate: 0.6,
          adverseSelectionBps: 3,
          skipFundingHours: true,
          requireSignificance: false,
          volRegime: false,
        });
        const withVolGate = runWalkForwardHourOfDay(candles, {
          trainBars: 4380,
          testBars: 720,
          topK: 3,
          bottomK: 3,
          smaPeriodBars: 24,
          longOnly: true,
          costs: MAKER_COSTS,
          makerFillRate: 0.6,
          adverseSelectionBps: 3,
          skipFundingHours: true,
          requireSignificance: false,
          volRegime: { minPercentile: 0.3, maxPercentile: 0.7 },
        });
        console.log(
          `  baseline  : trades=${baseline.totalTrades} ret=${(baseline.netReturnPct * 100).toFixed(1)}% sharpe=${baseline.sharpe.toFixed(2)} dd=${(baseline.maxDrawdownPct * 100).toFixed(1)}%`,
        );
        console.log(
          `  + vol gate: trades=${withVolGate.totalTrades} ret=${(withVolGate.netReturnPct * 100).toFixed(1)}% sharpe=${withVolGate.sharpe.toFixed(2)} dd=${(withVolGate.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }

      console.log("\n=== DEFLATED SHARPE per strategy ===");
      for (const s of ens.strategies) {
        if (s.returns.length < 20) continue;
        // K = number of strategies tried (rough proxy for multi-testing)
        const K = ens.strategies.length * 10; // include grid-search trials
        const dsr = computeDeflatedSharpe({
          returnsPct: s.returns.map((r) => r.pnlPct),
          trialsTried: K,
          periodsPerYear: 8760 / 3,
        });
        console.log(
          `  ${s.name.padEnd(22)}  sharpe=${dsr.sharpe.toFixed(2).padStart(6)}  ` +
            `expMax(K=${K})=${dsr.expectedMaxSharpe.toFixed(2)}  ` +
            `DSR=${dsr.deflatedSharpe.toFixed(3)}  ` +
            `${dsr.isSignificant95 ? "✓ significant 95%" : "✗ not significant"}  ` +
            `skew=${dsr.skewness.toFixed(2)} kurt=${dsr.kurtosis.toFixed(1)} n=${dsr.n}`,
        );
      }
    },
  );
});
