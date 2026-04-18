import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { checkStrategyHealth } from "../src/utils/strategyHealth";

describe("iteration 6", () => {
  it(
    "ensemble with funding-minute + strategy health",
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

      console.log("\n=== ENSEMBLE + FUNDING-MINUTE (11 strategies) ===");
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
      console.log(`Strategies: ${ens.strategies.length}`);
      for (const s of ens.strategies) {
        console.log(
          `  ${s.name.padEnd(24)}  n=${String(s.returns.length).padStart(4)}  sharpe=${s.sharpe.toFixed(2).padStart(6)}  weight=${(s.weight * 100).toFixed(1)}%`,
        );
      }
      console.log(
        `\nPORTFOLIO: ret=${(ens.totalReturnPct * 100).toFixed(1)}%  ann=${(ens.annualisedReturnPct * 100).toFixed(1)}%  vol=${(ens.annualisedVolPct * 100).toFixed(1)}%  sharpe=${ens.sharpe.toFixed(2)}  maxDD=${(ens.maxDrawdownPct * 100).toFixed(1)}%  WR=${(ens.winRate * 100).toFixed(0)}%`,
      );

      console.log("\n=== STRATEGY HEALTH (last 30 trades vs lifetime) ===");
      for (const s of ens.strategies) {
        if (s.returns.length < 60) continue;
        const h = checkStrategyHealth({
          strategyName: s.name,
          allReturns: s.returns.map((r) => r.pnlPct),
          recentWindow: 30,
        });
        const icon =
          h.status === "healthy" ? "✓" : h.status === "watch" ? "⚠" : "✗";
        console.log(
          `  ${icon} ${h.strategyName.padEnd(24)}  lifetime=${h.lifetimeSharpe.toFixed(2).padStart(6)}  recent=${h.recentSharpe.toFixed(2).padStart(6)}  ratio=${(h.ratio * 100).toFixed(0).padStart(4)}%  ${h.status.toUpperCase()}`,
        );
      }
    },
  );
});
