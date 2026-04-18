/**
 * Iter 15: Portfolio DSR on 13-strategy ensemble (including Coinbase
 * Premium), per-regime PnL of Premium, OKX historical candles test.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchFundingHistory } from "../src/utils/fundingRate";
import { buildEnsembleEquity } from "../src/utils/ensembleEquity";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import { computeDeflatedSharpe } from "../src/utils/deflatedSharpe";
import { classifyRegimes, pnlByRegime } from "../src/utils/regimeClassifier";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";

describe("iteration 15", () => {
  it(
    "13-strategy DSR + Premium regime analysis + OKX history",
    { timeout: 600_000 },
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
      const coinbaseBtc1h = await fetchCoinbaseLongHistory(
        "BTC-USD",
        3600,
        5000,
      );
      console.log(`Coinbase bars: ${coinbaseBtc1h.length}`);

      console.log("\n=== 13-STRATEGY PORTFOLIO DSR ===");
      const ens = await buildEnsembleEquity({
        candlesByH,
        fundingBySymbol,
        makerCosts: MAKER_COSTS,
        takerCosts: {
          takerFee: 0.0004,
          slippageBps: 2,
          fundingBpPerHour: 0.1,
        },
        coinbaseBtc1h,
      });
      console.log(`Strategies: ${ens.strategies.length}`);
      for (const s of ens.strategies) {
        console.log(
          `  ${s.name.padEnd(24)}  n=${String(s.returns.length).padStart(4)}  sharpe=${s.sharpe.toFixed(2).padStart(6)}  weight=${(s.weight * 100).toFixed(1)}%`,
        );
      }
      const dailyPnl = ens.dailyReturns.map((d) => d.pnlPct);
      const dsr = computeDeflatedSharpe({
        returnsPct: dailyPnl,
        trialsTried: 156, // 13 × 12
        periodsPerYear: 365,
      });
      console.log(
        `\nPORTFOLIO: ret=${(ens.totalReturnPct * 100).toFixed(1)}%  ann=${(ens.annualisedReturnPct * 100).toFixed(1)}%  vol=${(ens.annualisedVolPct * 100).toFixed(1)}%  sharpe=${ens.sharpe.toFixed(2)}  maxDD=${(ens.maxDrawdownPct * 100).toFixed(1)}%  WR=${(ens.winRate * 100).toFixed(0)}%`,
      );
      console.log(
        `DSR: sharpe=${dsr.sharpe.toFixed(2)}  expMax(K=156)=${dsr.expectedMaxSharpe.toFixed(2)}  DSR=${dsr.deflatedSharpe.toFixed(3)}  ${dsr.isSignificant95 ? "✓ significant 95%" : "✗ not significant"}  skew=${dsr.skewness.toFixed(2)} kurt=${dsr.kurtosis.toFixed(1)}`,
      );

      console.log("\n=== COINBASE PREMIUM: PnL by regime ===");
      const btcWindows = classifyRegimes(
        candlesByH["BTCUSDT"],
        fundingBySymbol["BTCUSDT"],
      );
      const premium = ens.strategies.find(
        (s) => s.name === "CoinbasePremium-BTC",
      );
      if (premium) {
        const pbr = pnlByRegime(
          btcWindows,
          premium.returns.map((r) => ({ time: r.time, pnlPct: r.pnlPct })),
        );
        const parts = Object.entries(pbr)
          .filter(([, v]) => v.n > 0)
          .map(
            ([k, v]) =>
              `${k}:n=${v.n},mean=${(v.meanPct * 100).toFixed(2)}%,sum=${(v.totalPct * 100).toFixed(1)}%`,
          )
          .join("  ");
        console.log(`  CoinbasePremium-BTC  ${parts}`);
      } else {
        console.log("  (Coinbase Premium had no trades)");
      }

      console.log("\n=== OKX HISTORICAL CANDLES TEST ===");
      try {
        const res = await fetch(
          "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=100",
        );
        if (res.ok) {
          const json = (await res.json()) as {
            code: string;
            data: string[][];
          };
          console.log(
            `  OKX public candles: code=${json.code}, rows=${json.data?.length ?? 0}`,
          );
          if (json.data && json.data.length > 0) {
            const first = json.data[json.data.length - 1];
            const last = json.data[0];
            console.log(
              `  range: ${new Date(parseInt(first[0])).toISOString().slice(0, 10)} → ${new Date(parseInt(last[0])).toISOString().slice(0, 10)}`,
            );
          }
        } else {
          console.log(`  OKX candles failed: ${res.status}`);
        }
      } catch (err) {
        console.log(
          `  OKX error: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
    },
  );
});
