/**
 * Iter 29: Confluence-filtered Coinbase Premium backtest.
 *
 * Validates whether the iter25 5-star alert "confluence-aligned" filter
 * actually improves Sharpe vs baseline (unfiltered) on historical data.
 *
 * Cohort: ~5000 1h bars of (Coinbase BTC-USD, Binance BTCUSDT, Bybit BTCUSDT
 * spot, Bybit BTCUSDT linear). Each Coinbase Premium signal is scored against
 * the Bybit Basis at that bar, and either taken or skipped per filter rule.
 */
import { describe, it } from "vitest";
import { fetchCoinbaseLongHistory } from "../src/utils/coinbaseHistory";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchBybitKlines } from "../src/utils/bybitHistory";
import {
  runConfluenceBacktest,
  type ConfluenceBacktestConfig,
} from "../src/utils/confluenceFilteredBacktest";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 29 — confluence filter validation", () => {
  it(
    "Premium ⊕ Basis confluence vs baseline",
    { timeout: 600_000 },
    async () => {
      console.log("\n=== ITER 29: CONFLUENCE-FILTERED PREMIUM BACKTEST ===");
      console.log("Fetching Coinbase BTC-USD 1h history...");
      const cb = await fetchCoinbaseLongHistory("BTC-USD", 3600, 5000);
      console.log(`  Coinbase candles: ${cb.length}`);
      if (cb.length < 500) {
        console.log("  Coinbase rate-limited or empty. Aborting.");
        return;
      }

      console.log("Fetching Binance BTCUSDT 1h...");
      const bnb = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "1h",
        targetCount: 8000,
      });
      console.log(`  Binance candles: ${bnb.length}`);

      console.log("Fetching Bybit BTCUSDT spot 1h...");
      const bybSpot = await fetchBybitKlines({
        category: "spot",
        symbol: "BTCUSDT",
        interval: "60",
        targetCount: 8000,
      });
      console.log(`  Bybit spot candles: ${bybSpot.length}`);

      console.log("Fetching Bybit BTCUSDT linear-perp 1h...");
      const bybPerp = await fetchBybitKlines({
        category: "linear",
        symbol: "BTCUSDT",
        interval: "60",
        targetCount: 8000,
      });
      console.log(`  Bybit perp candles: ${bybPerp.length}`);

      const baseCfg: Omit<ConfluenceBacktestConfig, "filter"> = {
        minPremiumPct: 0.0015,
        consecutiveBars: 2,
        holdBars: 24,
        stopPct: 0.015,
        longOnly: false,
        costs: MAKER_COSTS,
        alignThreshold: 0.3,
        opposeThreshold: 0.5,
      };

      const variants: ConfluenceBacktestConfig["filter"][] = [
        "none",
        "no-hard-oppose",
        "aligned",
        "aligned+no-oppose",
      ];

      console.log("\n=== RESULTS (Premium 2x0.15% / 24h hold / 1.5% stop) ===");
      console.log(
        "filter".padEnd(20) +
          "fired".padStart(7) +
          "taken".padStart(7) +
          "ret%".padStart(9) +
          "WR%".padStart(7) +
          "PF".padStart(7) +
          "Sharpe".padStart(9) +
          "DD%".padStart(7),
      );
      for (const f of variants) {
        const rep = runConfluenceBacktest(cb, bnb, bybSpot, bybPerp, {
          ...baseCfg,
          filter: f,
        });
        console.log(
          f.padEnd(20) +
            String(rep.signalsFired).padStart(7) +
            String(rep.signalsTaken).padStart(7) +
            (rep.netReturnPct * 100).toFixed(1).padStart(9) +
            (rep.winRate * 100).toFixed(0).padStart(7) +
            rep.profitFactor.toFixed(2).padStart(7) +
            rep.sharpe.toFixed(2).padStart(9) +
            (rep.maxDrawdownPct * 100).toFixed(1).padStart(7),
        );
      }

      // Tighter threshold variant — does looser align (0.15) help?
      console.log(
        "\n=== Sensitivity: alignThreshold sweep (filter=aligned) ===",
      );
      for (const t of [0.15, 0.2, 0.3, 0.4, 0.5]) {
        const rep = runConfluenceBacktest(cb, bnb, bybSpot, bybPerp, {
          ...baseCfg,
          filter: "aligned",
          alignThreshold: t,
        });
        console.log(
          `  align≥${t.toFixed(2)}: taken=${rep.signalsTaken}/${rep.signalsFired}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  Sharpe=${rep.sharpe.toFixed(2)}  WR=${(rep.winRate * 100).toFixed(0)}%  DD=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    },
  );
});
