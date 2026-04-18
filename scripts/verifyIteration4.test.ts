/**
 * Iteration 4 verification:
 *   1. OI + Taker-Imbalance (Easley 2024)
 *   2. BTC → ALT lead-lag (Aliyev 2025)
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { fetchOpenInterestHistory } from "../src/utils/openInterest";
import { runOiTakerBacktest } from "../src/utils/oiTakerStrategy";
import { runLeadLagBacktest } from "../src/utils/leadLagStrategy";
import { MAKER_COSTS } from "../src/utils/intradayLab";

describe("iteration 4", () => {
  it("OI + Taker-Imbalance (30d history)", { timeout: 180_000 }, async () => {
    console.log("\n=== OI + TAKER-IMBALANCE STRATEGY ===");
    for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
      const [candles, oi] = await Promise.all([
        loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 720,
        }),
        fetchOpenInterestHistory({ symbol: sym, period: "1h", limit: 500 }),
      ]);
      console.log(`${sym}: candles=${candles.length}  oi_samples=${oi.length}`);
      if (oi.length < 100) {
        console.log(`  skipping — insufficient OI history`);
        continue;
      }
      // Use shorter window since we only have 30d history
      const rep = runOiTakerBacktest(candles, oi, {
        oiSigmaThreshold: 2.0,
        oiSigmaWindowBars: 168, // 7 days given 30d total
        longTakerRatio: 0.55,
        shortTakerRatio: 0.45,
        vwapBars: 24,
        holdBarsMax: 8,
        oiExitSigma: -1.0,
        stopPctR: 2.0,
        costs: MAKER_COSTS,
      });
      console.log(
        `  signals=${rep.signalsFired}  trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%  avgHold=${rep.avgHoldBars.toFixed(1)}h`,
      );
    }
  });

  it("BTC → ALT lead-lag", { timeout: 180_000 }, async () => {
    console.log("\n=== BTC → ALT LEAD-LAG ===");
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "1h",
      targetCount: 20000,
    });
    for (const alt of ["ETHUSDT", "SOLUSDT"]) {
      const altCandles = await loadBinanceHistory({
        symbol: alt,
        timeframe: "1h",
        targetCount: 20000,
      });
      for (const cfg of [
        { btcThresholdPct: 0.01, altMaxMovePct: 0.005, holdBarsMax: 3 },
        { btcThresholdPct: 0.015, altMaxMovePct: 0.005, holdBarsMax: 3 },
        { btcThresholdPct: 0.02, altMaxMovePct: 0.008, holdBarsMax: 3 },
        { btcThresholdPct: 0.015, altMaxMovePct: 0.005, holdBarsMax: 6 },
      ]) {
        const rep = runLeadLagBacktest(btc, altCandles, alt, {
          ...cfg,
          targetRatioToBtc: 0.7,
          stopPctBtcReversal: 0.008,
          costs: MAKER_COSTS,
        });
        console.log(
          `${alt} (btcT=${cfg.btcThresholdPct * 100}% altMax=${cfg.altMaxMovePct * 100}% hold=${cfg.holdBarsMax}h): trades=${rep.trades.length}  ret=${(rep.netReturnPct * 100).toFixed(1)}%  WR=${(rep.winRate * 100).toFixed(0)}%  PF=${rep.profitFactor.toFixed(2)}  sharpe=${rep.sharpe.toFixed(2)}  dd=${(rep.maxDrawdownPct * 100).toFixed(1)}%`,
        );
      }
    }
  });
});
