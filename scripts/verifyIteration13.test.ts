/**
 * Iter 13 verification — Coinbase Premium BACKTEST.
 * Fetches ~2000 Coinbase 1h bars (rate-limited) + Binance 1h bars,
 * runs the premium-based strategy on the overlap.
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";
import { runPremiumBacktest } from "../src/utils/premiumBacktest";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 13 — Coinbase Premium backtest", () => {
  it("fetch + backtest 2000 bars", { timeout: 300_000 }, async () => {
    console.log("\n=== COINBASE PREMIUM BACKTEST (BTC, 1h) ===");
    const cb = await fetchCoinbaseLongHistory("BTC-USD", 3600, 2000);
    console.log(`Coinbase candles: ${cb.length}`);
    if (cb.length < 100) {
      console.log("  too few Coinbase bars — skipping");
      return;
    }
    const bnb = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 4000,
    });
    console.log(`Binance candles: ${bnb.length}`);

    for (const cfg of [
      {
        name: "default (2×0.15%, 24h hold)",
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: true,
      },
      {
        name: "loose (1×0.1%, 12h hold)",
        minPremiumPct: 0.001,
        consecutiveBars: 1,
        holdBars: 12,
        stopPct: 0.015,
        longOnly: true,
      },
      {
        name: "strict (3×0.2%, 48h hold)",
        minPremiumPct: 0.002,
        consecutiveBars: 3,
        holdBars: 48,
        stopPct: 0.02,
        longOnly: true,
      },
      {
        name: "long+short (2×0.15%, 24h)",
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
      },
    ]) {
      const rep = runPremiumBacktest(cb, bnb, {
        ...cfg,
        costs: MAKER_COSTS,
      });
      console.log(
        `  ${cfg.name.padEnd(32)} signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    // Diagnostics
    const test = runPremiumBacktest(cb, bnb, {
      minPremiumPct: 0.0015,
      consecutiveBars: 2,
      holdBars: 24,
      stopPct: 0.015,
      longOnly: true,
      costs: MAKER_COSTS,
    });
    console.log(
      `\n  Premium stats (${cb.length} bars): mean=${(test.premiumMean * 100).toFixed(4)}% std=${(test.premiumStd * 100).toFixed(4)}% max=${(test.premiumMax * 100).toFixed(3)}% min=${(test.premiumMin * 100).toFixed(3)}%`,
    );
  });
});
