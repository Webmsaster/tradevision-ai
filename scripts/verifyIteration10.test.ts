/**
 * Iter 10 verification:
 *   1. Portfolio-level DSR on 12-strategy ensemble daily returns
 *   2. Regime classification + regime mix of sample
 *   3. PnL per regime for top strategies
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { computeDeflatedSharpe } from "../src/utils/deflatedSharpe";
import {
  classifyRegimes,
  regimeMix,
  pnlByRegime,
} from "../src/utils/regimeClassifier";

describe("iteration 10", () => {
  it("portfolio DSR + regime analysis", { timeout: 300_000 }, async () => {
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

    console.log("\n=== PORTFOLIO-LEVEL DEFLATED SHARPE ===");
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
    const dailyPnl = ens.dailyReturns.map((d) => d.pnlPct);
    console.log(
      `Daily bars: ${dailyPnl.length}. Portfolio Sharpe=${ens.sharpe.toFixed(2)} over ${dailyPnl.length} days.`,
    );
    const dsr = computeDeflatedSharpe({
      returnsPct: dailyPnl,
      trialsTried: 144, // 12 strategies × ~12 config tweaks per strategy
      periodsPerYear: 365,
    });
    console.log(
      `Portfolio DSR: sharpe=${dsr.sharpe.toFixed(2)}  expMax(K=144)=${dsr.expectedMaxSharpe.toFixed(2)}  DSR=${dsr.deflatedSharpe.toFixed(3)}  ${dsr.isSignificant95 ? "✓ significant 95%" : "✗ not significant"}  skew=${dsr.skewness.toFixed(2)} kurt=${dsr.kurtosis.toFixed(1)}`,
    );

    console.log("\n=== REGIME CLASSIFICATION (weekly windows) ===");
    for (const sym of syms) {
      const windows = classifyRegimes(candlesByH[sym], fundingBySymbol[sym]);
      const mix = regimeMix(windows);
      console.log(
        `${sym}: ${windows.length} weekly windows. Mix: ` +
          Object.entries(mix)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
            .join(" "),
      );
    }

    console.log("\n=== PnL BY REGIME for top strategies ===");
    const btcWindows = classifyRegimes(
      candlesByH["BTCUSDT"],
      fundingBySymbol["BTCUSDT"],
    );
    for (const s of ens.strategies) {
      if (s.returns.length < 20) continue;
      const pbr = pnlByRegime(
        btcWindows,
        s.returns.map((r) => ({ time: r.time, pnlPct: r.pnlPct })),
      );
      const parts = Object.entries(pbr)
        .filter(([, v]) => v.n > 0)
        .map(
          ([k, v]) =>
            `${k.slice(0, 6)}:n=${v.n},mean=${(v.meanPct * 100).toFixed(2)}%`,
        )
        .join("  ");
      console.log(`  ${s.name.padEnd(24)}  ${parts}`);
    }
  });
});
