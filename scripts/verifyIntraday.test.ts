/**
 * Verifies the two new intraday strategies against live Binance data.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  computeHourStats,
  runHourOfDayStrategy,
  runHourStrategyWalkForward,
} from "../src/utils/hourOfDayStrategy";
import { runFundingReversionBacktest } from "../src/utils/fundingReversion";
import { fetchFundingHistory } from "../src/utils/fundingRate";

describe("intraday edges (live Binance)", () => {
  it(
    "hour-of-day seasonality on 1h bars (BTC/ETH/SOL)",
    { timeout: 180_000 },
    async () => {
      console.log("\n=== HOUR-OF-DAY SEASONALITY (1h bars) ===\n");
      const MAKER_COSTS = {
        takerFee: 0.0002, // 0.02% maker (post-only limit order)
        slippageBps: 0, // no slippage on fills at your price
        fundingBpPerHour: 0.1,
      };
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const candles = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 6000,
        });
        const stats = computeHourStats(candles);
        const significant = stats.filter((s) => s.significant);
        console.log(`${sym} (${candles.length} 1h bars)`);
        console.log(
          `  significant hours (|t|>2): ` +
            significant
              .map(
                (s) =>
                  `${String(s.hourUtc).padStart(2, "0")}:${(s.meanReturnPct * 100).toFixed(3)}%(t=${s.tStat.toFixed(2)})`,
              )
              .join(" ") || "  (none significant)",
        );
        const taker = runHourOfDayStrategy(candles, stats);
        const maker = runHourOfDayStrategy(candles, stats, {
          longTopK: 3,
          shortBottomK: 3,
          requireSignificance: true,
          costs: MAKER_COSTS,
        });
        console.log(
          `  IN-SAMPLE (taker): trades=${taker.totalTrades} ret=${(taker.netReturnPct * 100).toFixed(1)}% WR=${(taker.winRate * 100).toFixed(1)}% sharpe=${taker.sharpe.toFixed(2)}`,
        );
        console.log(
          `  IN-SAMPLE (maker): trades=${maker.totalTrades} ret=${(maker.netReturnPct * 100).toFixed(1)}% WR=${(maker.winRate * 100).toFixed(1)}% sharpe=${maker.sharpe.toFixed(2)}`,
        );
        console.log(`  long hours: [${taker.bestHours.join(",")}]`);
        console.log(`  short hours: [${taker.worstHours.join(",")}]`);
        // Out-of-sample (walk-forward 50/50)
        const oos = runHourStrategyWalkForward(candles, 0.5, {
          longTopK: 3,
          shortBottomK: 3,
          requireSignificance: true,
          costs: MAKER_COSTS,
        });
        console.log(
          `  OOS (maker, 50/50): trades=${oos.totalTrades} ret=${(oos.netReturnPct * 100).toFixed(1)}% WR=${(oos.winRate * 100).toFixed(1)}% sharpe=${oos.sharpe.toFixed(2)} dd=${(oos.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    },
  );

  it(
    "funding-rate extreme mean-reversion (BTC/ETH/SOL)",
    { timeout: 180_000 },
    async () => {
      console.log("\n=== FUNDING-RATE EXTREME MEAN-REVERSION ===\n");
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const [candles, funding] = await Promise.all([
          loadBinanceHistory({
            symbol: sym,
            timeframe: "1h",
            targetCount: 20000, // ~800 days on 1h
          }),
          fetchFundingHistory(sym, 3000),
        ]);
        console.log(
          `  ${sym}: candles ${candles.length} from ${new Date(candles[0]?.openTime ?? 0).toISOString().slice(0, 10)}, funding ${funding.length} from ${new Date(funding[0]?.fundingTime ?? 0).toISOString().slice(0, 10)}`,
        );
        for (const mode of [
          "reversion",
          "continuation",
          "regime-aware",
        ] as const) {
          const rep = runFundingReversionBacktest(candles, funding, {
            entryPosFunding: 0.0005,
            entryNegFunding: 0.0004,
            holdBars: 8,
            stopPct: 0.01,
            targetPct: 0.006,
            mode,
            smaPeriod: 200,
          });
          console.log(
            `  ${mode.padEnd(15)}: trades=${rep.trades.length} ` +
              `ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(0)}% ` +
              `PF=${rep.profitFactor.toFixed(2)} sharpe=${rep.sharpe.toFixed(2)} ` +
              `dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
          );
        }
        const rep = runFundingReversionBacktest(candles, funding);
        console.log(
          `${sym}: trades=${rep.trades.length} (${rep.longCount}L/${rep.shortCount}S) ` +
            `ret=${(rep.netReturnPct * 100).toFixed(1)}% WR=${(rep.winRate * 100).toFixed(1)}% ` +
            `PF=${rep.profitFactor.toFixed(2)} sharpe=${rep.sharpe.toFixed(2)} ` +
            `dd=${(rep.maxDrawdownPct * 100).toFixed(1)}% avgHold=${rep.avgHoldingHours.toFixed(1)}h`,
        );
      }
    },
  );
});
