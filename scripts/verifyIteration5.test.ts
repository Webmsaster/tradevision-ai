/**
 * Iteration 5 verification:
 *   - Ensemble equity with Lead-Lag added
 *   - Rolling DSR on Champion-SOL
 *   - Funding-Settlement-Minute reversion
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { computeRollingDsr } from "../src/utils/rollingDsr";
import { runFundingMinuteBacktest } from "../src/utils/fundingMinuteReversion";

describe("iteration 5", () => {
  it(
    "ensemble + rolling DSR + funding-minute reversion",
    { timeout: 300_000 },
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

      console.log("\n=== ENSEMBLE WITH LEAD-LAG ADDED ===");
      const ens = await buildEnsembleEquity({
        candlesByH,
        fundingBySymbol,
        makerCosts: MAKER_COSTS,
        takerCosts: {
          takerFee: 0.0004,
          slippageBps: 2,
          fundingBpPerHour: 0.1,
        },
      });
      console.log(
        `Strategies: ${ens.strategies.length}, trades: ${ens.totalTrades}`,
      );
      for (const s of ens.strategies) {
        console.log(
          `  ${s.name.padEnd(24)}  n=${String(s.returns.length).padStart(4)}  sharpe=${s.sharpe.toFixed(2).padStart(6)}  weight=${(s.weight * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `\nPORTFOLIO: ret=${(ens.totalReturnPct * 100).toFixed(1)}%  ann=${(ens.annualisedReturnPct * 100).toFixed(1)}%  vol=${(ens.annualisedVolPct * 100).toFixed(1)}%  sharpe=${ens.sharpe.toFixed(2)}  maxDD=${(ens.maxDrawdownPct * 100).toFixed(1)}%  WR=${(ens.winRate * 100).toFixed(0)}%  days=${ens.dailyReturns.length}`,
      );

      console.log(
        "\n=== ROLLING DSR for each strategy (90-trade window, 30-trade step) ===",
      );
      for (const s of ens.strategies) {
        if (s.returns.length < 100) continue;
        const rep = computeRollingDsr({
          returnsPct: s.returns.map((r) => r.pnlPct),
          trialsTried: 90,
          periodsPerYear: 8760 / 3,
          windowBars: 90,
          stepBars: 30,
        });
        console.log(
          `  ${s.name.padEnd(24)}  windows=${rep.points.length}  meanDSR=${rep.meanDsr.toFixed(3)}  minDSR=${rep.minDsr.toFixed(3)}  maxDSR=${rep.maxDsr.toFixed(3)}  share≥0.95=${(rep.share95 * 100).toFixed(0)}%  ≥0.80=${(rep.share80 * 100).toFixed(0)}%  ≥0.50=${(rep.share50 * 100).toFixed(0)}%`,
        );
      }

      console.log("\n=== FUNDING-SETTLEMENT-MINUTE REVERSION (Inan 2025) ===");
      for (const sym of syms) {
        const rep = runFundingMinuteBacktest(
          candlesByH[sym],
          fundingBySymbol[sym],
          {
            minFundingAbs: 0.0005,
            entryBarsBefore: 1,
            exitBarsAfter: 1,
            stopPct: 0.01,
            costs: MAKER_COSTS,
          },
        );
        console.log(
          `${sym}: signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    },
  );
});
