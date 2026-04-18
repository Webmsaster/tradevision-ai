/**
 * Offline verification test: runs the research matrix against LIVE Binance
 * klines and prints the verdict table. Skip in CI. Run manually:
 *   node ./node_modules/vitest/vitest.mjs run scripts/verifyEdge.test.ts
 */
import { describe, it } from "vitest";
import { runAutoMatrix } from "../src/utils/autoMatrix";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

describe("strategy edge verification (live Binance data)", () => {
  it("prints matrix of positive edges", { timeout: 180_000 }, async () => {
    const tfs: LiveTimeframe[] = ["1h", "4h", "1d", "1w"];
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    const rows = await runAutoMatrix({
      symbols,
      timeframes: tfs,
      targetCount: 6000,
    });

    const winners = rows
      .filter(
        (r) => r.verdict === "positive" || r.verdict === "low-freq-positive",
      )
      .sort((a, b) => b.sharpe - a.sharpe);

    console.log(`\n=== POSITIVE EDGES: ${winners.length} / ${rows.length} ===`);
    winners.forEach((r) => {
      console.log(
        `  ${r.symbol} ${r.timeframe.padEnd(3)} ${r.mode.padEnd(15)} ` +
          `trades=${String(r.trades).padStart(4)} ` +
          `ret=${(r.totalReturnPct * 100).toFixed(1)}% ` +
          `sharpe=${r.sharpe.toFixed(2)} pf=${r.profitFactor.toFixed(2)} ` +
          `dd=${(r.maxDrawdownPct * 100).toFixed(1)}% [${r.verdict}]`,
      );
    });

    console.log("\n=== TOP 15 BY SHARPE ===");
    rows.slice(0, 15).forEach((r) => {
      console.log(
        `  ${r.symbol} ${r.timeframe.padEnd(3)} ${r.mode.padEnd(15)} ` +
          `sharpe=${r.sharpe.toFixed(2)} ` +
          `ret=${(r.totalReturnPct * 100).toFixed(1)}% ` +
          `pf=${r.profitFactor.toFixed(2)} trades=${r.trades} ` +
          `[${r.verdict}]`,
      );
    });
  });
});
