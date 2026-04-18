/**
 * Iter 14: longer Coinbase history + OKX premium snapshot
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";
import { runPremiumBacktest } from "../src/utils/premiumBacktest";
import { fetchOkxPremium } from "../src/utils/okxPremium";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 14", () => {
  it("longer Coinbase Premium backtest", { timeout: 600_000 }, async () => {
    console.log("\n=== COINBASE PREMIUM BACKTEST (extended) ===");
    const cb = await fetchCoinbaseLongHistory("BTC-USD", 3600, 5000);
    console.log(`Coinbase candles: ${cb.length}`);
    if (cb.length < 500) {
      console.log(
        "  Coinbase returned too few bars (rate-limited?). Skipping backtest.",
      );
      return;
    }
    const bnb = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 8000,
    });
    console.log(`Binance candles: ${bnb.length}`);

    for (const cfg of [
      {
        name: "long+short 2×0.15% 24h",
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "long+short 2×0.1% 12h",
        minPremiumPct: 0.001,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.012,
        longOnly: false,
      },
      {
        name: "long+short 3×0.15% 24h",
        minPremiumPct: 0.0015,
        consecutiveBars: 3,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "short-only 2×0.15% 24h",
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: true, // will miss short side — verify behavior
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
  });

  it("OKX-Binance live premium", { timeout: 30_000 }, async () => {
    const s = await fetchOkxPremium();
    console.log("\n=== OKX PREMIUM (BTC-USDT) ===");
    console.log(
      `  OKX: $${s.okxPriceUsdt.toFixed(2)}  Binance: $${s.binancePriceUsdt.toFixed(2)}`,
    );
    console.log(
      `  Premium: ${(s.premiumPct * 100).toFixed(4)}%  Signal: ${s.signal.toUpperCase()}  Magnitude: ${s.magnitude}`,
    );
    console.log(`  ${s.interpretation}`);
  });
});
