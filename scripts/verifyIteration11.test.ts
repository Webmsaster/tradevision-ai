/**
 * Iter 11 verification:
 *   1. Rolling-window Portfolio DSR (is significance stable?)
 *   2. Regime-gated portfolio: compare ungated vs gated PnL
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { computeRollingDsr } from "../src/utils/rollingDsr";
import { computeDeflatedSharpe } from "../src/utils/deflatedSharpe";
import { classifyRegimes } from "../src/utils/regimeClassifier";
import { filterTradesByRegime } from "../src/utils/regimeGate";

describe("iteration 11", () => {
  it(
    "rolling portfolio DSR + regime-gated portfolio",
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
        "\n=== ROLLING PORTFOLIO DSR (90-day window, 30-day step) ===",
      );
      const dailyRets = ens.dailyReturns.map((d) => d.pnlPct);
      const rolling = computeRollingDsr({
        returnsPct: dailyRets,
        trialsTried: 144,
        periodsPerYear: 365,
        windowBars: 90,
        stepBars: 30,
      });
      console.log(
        `  windows=${rolling.points.length}  meanDSR=${rolling.meanDsr.toFixed(3)}  minDSR=${rolling.minDsr.toFixed(3)}  maxDSR=${rolling.maxDsr.toFixed(3)}  share≥0.95=${(rolling.share95 * 100).toFixed(0)}%  ≥0.80=${(rolling.share80 * 100).toFixed(0)}%  ≥0.50=${(rolling.share50 * 100).toFixed(0)}%`,
      );
      for (const p of rolling.points) {
        console.log(
          `    day=${p.windowEnd}  sharpe=${p.sharpe.toFixed(2)}  DSR=${p.deflatedSharpe.toFixed(3)}`,
        );
      }

      console.log("\n=== REGIME-GATED PORTFOLIO (BTC regime as master) ===");
      const btcWindows = classifyRegimes(
        candlesByH["BTCUSDT"],
        fundingBySymbol["BTCUSDT"],
      );
      const sortedWindows = [...btcWindows].sort(
        (a, b) => a.startTime - b.startTime,
      );
      function regimeAt(
        t: number,
      ): ReturnType<typeof classifyRegimes>[0]["regime"] | null {
        let lo = 0,
          hi = sortedWindows.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (sortedWindows[mid].startTime > t) hi = mid - 1;
          else if (sortedWindows[mid].endTime < t) lo = mid + 1;
          else return sortedWindows[mid].regime;
        }
        return null;
      }

      // Flatten all strategy trades with strategy-tag preserved
      const allTrades = ens.strategies.flatMap((s) =>
        s.returns.map((r) => ({
          time: r.time,
          pnlPct: r.pnlPct,
          strategy: s.name,
        })),
      );
      const { kept, dropped } = filterTradesByRegime(allTrades, regimeAt);
      console.log(
        `  Ungated: ${allTrades.length} trades. Regime-gated: ${kept.length} kept, ${dropped.length} dropped`,
      );

      // Recompute portfolio stats on kept (naive — treat each trade as
      // individual return observation since we'd need to re-allocate weights
      // for true portfolio backtest)
      function sharpeOf(rets: number[]): number {
        if (rets.length < 2) return 0;
        const m = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length;
        const sd = Math.sqrt(v);
        return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
      }
      const ungatedSharpe = sharpeOf(allTrades.map((t) => t.pnlPct));
      const gatedSharpe = sharpeOf(kept.map((t) => t.pnlPct));
      const droppedSharpe = sharpeOf(dropped.map((t) => t.pnlPct));
      console.log(
        `  Ungated per-trade Sharpe=${ungatedSharpe.toFixed(2)}  Gated=${gatedSharpe.toFixed(2)}  Dropped-only=${droppedSharpe.toFixed(2)}`,
      );
      const ungatedMean =
        allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length;
      const gatedMean =
        kept.reduce((s, t) => s + t.pnlPct, 0) / Math.max(1, kept.length);
      const droppedMean =
        dropped.reduce((s, t) => s + t.pnlPct, 0) / Math.max(1, dropped.length);
      console.log(
        `  Ungated mean=${(ungatedMean * 100).toFixed(3)}%  Gated mean=${(gatedMean * 100).toFixed(3)}%  Dropped mean=${(droppedMean * 100).toFixed(3)}%`,
      );
    },
  );
});
