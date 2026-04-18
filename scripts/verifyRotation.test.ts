/**
 * Verifies the cross-sectional momentum rotation against live Binance data.
 * Run:  node ./node_modules/vitest/vitest.mjs run scripts/verifyRotation.test.ts
 */
import { describe, it } from "vitest";
import {
  fetchRotationCandles,
  runCrossSectionalRotation,
} from "../src/utils/crossSectional";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

describe("cross-sectional rotation (live)", () => {
  it(
    "rotates BTC/ETH/SOL weekly on 4-week ROC",
    { timeout: 180_000 },
    async () => {
      const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
      const tfs: { tf: LiveTimeframe; lookback: number; target: number }[] = [
        { tf: "1w", lookback: 4, target: 400 },
        { tf: "1w", lookback: 8, target: 400 },
        { tf: "1w", lookback: 12, target: 400 },
        { tf: "1d", lookback: 28, target: 2000 },
        { tf: "1d", lookback: 56, target: 2000 },
      ];

      console.log("\n=== CROSS-SECTIONAL MOMENTUM ROTATION ===\n");
      for (const { tf, lookback, target } of tfs) {
        const byCandles = await fetchRotationCandles(symbols, tf, target);
        const minLen = Math.min(
          ...Object.values(byCandles).map((c) => c.length),
        );
        const rep = runCrossSectionalRotation({
          byCandles,
          timeframe: tf,
          config: {
            lookbackBars: lookback,
            topN: 1,
            skipLastBars: 0,
            rebalanceEveryBar: true,
          },
        });
        console.log(
          `  tf=${tf} lookback=${lookback} minBars=${minLen} ` +
            `trades=${rep.metrics.trades} ` +
            `ret=${(rep.metrics.totalReturnPct * 100).toFixed(1)}% ` +
            `WR=${(rep.metrics.winRate * 100).toFixed(0)}% ` +
            `sharpe=${rep.metrics.sharpe.toFixed(2)} ` +
            `pf=${rep.metrics.profitFactor.toFixed(2)} ` +
            `dd=${(rep.metrics.maxDrawdownPct * 100).toFixed(1)}% ` +
            `calmar=${rep.metrics.calmar.toFixed(2)}`,
        );
      }
    },
  );
});
