import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchOkxLongHistory } from "../src/utils/okxPremium";
import { runPremiumBacktest } from "../src/utils/premiumBacktest";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 16", () => {
  it("OKX-Binance Premium backtest", { timeout: 600_000 }, async () => {
    console.log("\n=== OKX HISTORICAL FETCH ===");
    const okx = await fetchOkxLongHistory("BTC-USDT", "1H", 5000);
    console.log(`OKX bars: ${okx.length}`);
    if (okx.length < 500) {
      console.log("  OKX returned too few bars. Skipping.");
      return;
    }
    console.log(
      `  range: ${new Date(okx[0].openTime).toISOString().slice(0, 10)} → ${new Date(okx[okx.length - 1].openTime).toISOString().slice(0, 10)}`,
    );
    const bnb = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 8000,
    });
    console.log(`Binance bars: ${bnb.length}`);

    console.log("\n=== OKX-BINANCE PREMIUM BACKTEST ===");
    for (const cfg of [
      {
        name: "long+short 2×0.1% 12h",
        minPremiumPct: 0.001,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.012,
        longOnly: false,
      },
      {
        name: "long+short 2×0.05% 12h",
        minPremiumPct: 0.0005,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.012,
        longOnly: false,
      },
      {
        name: "long+short 3×0.1% 24h",
        minPremiumPct: 0.001,
        consecutiveBars: 3,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
      },
      {
        name: "long+short 2×0.15% 24h",
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
      },
    ]) {
      const rep = runPremiumBacktest(okx, bnb, {
        ...cfg,
        costs: MAKER_COSTS,
      });
      console.log(
        `  ${cfg.name.padEnd(32)} signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
      );
    }

    const diag = runPremiumBacktest(okx, bnb, {
      minPremiumPct: 0.001,
      consecutiveBars: 2,
      holdBars: 12,
      stopPct: 0.012,
      longOnly: false,
      costs: MAKER_COSTS,
    });
    console.log(
      `\n  Premium stats (${okx.length} bars): mean=${(diag.premiumMean * 100).toFixed(4)}% std=${(diag.premiumStd * 100).toFixed(4)}% max=${(diag.premiumMax * 100).toFixed(3)}% min=${(diag.premiumMin * 100).toFixed(3)}%`,
    );
  });
});
