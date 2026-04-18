/**
 * Offline verification that runs the full strategy matrix against real Binance
 * klines and prints a table of verdicts. Use:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/verifyEdge.ts
 * or via vitest (quicker because deps are already resolved):
 *   node ./node_modules/vitest/vitest.mjs run scripts/verifyEdge.ts
 */
import { runAutoMatrix } from "../src/utils/autoMatrix";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

async function main() {
  const tfs: LiveTimeframe[] = ["1h", "4h", "1d", "1w"];
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  console.log("Running matrix (this fetches live Binance data)…");
  const rows = await runAutoMatrix({
    symbols,
    timeframes: tfs,
    targetCount: 6000,
    onProgress: (done, total, label) => {
      process.stdout.write(`\r${done}/${total}  ${label.padEnd(40)}`);
    },
  });
  console.log("\n");
  const winners = rows
    .filter(
      (r) => r.verdict === "positive" || r.verdict === "low-freq-positive",
    )
    .sort((a, b) => b.sharpe - a.sharpe);
  console.log(
    `\n=== POSITIVE EDGES FOUND: ${winners.length} / ${rows.length} ===\n`,
  );
  if (winners.length === 0) {
    console.log("NONE. Top 10 by Sharpe anyway:");
    rows.slice(0, 10).forEach((r) => {
      console.log(
        `  ${r.symbol} ${r.timeframe.padEnd(3)} ${r.mode.padEnd(15)} ` +
          `trades=${String(r.trades).padStart(4)} ret=${(r.totalReturnPct * 100).toFixed(1)}% ` +
          `sharpe=${r.sharpe.toFixed(2)} pf=${r.profitFactor.toFixed(2)} ` +
          `dd=${(r.maxDrawdownPct * 100).toFixed(1)}%  [${r.verdict}]`,
      );
    });
    return;
  }
  winners.forEach((r) => {
    console.log(
      `  ${r.symbol} ${r.timeframe.padEnd(3)} ${r.mode.padEnd(15)} ` +
        `trades=${String(r.trades).padStart(4)} ret=${(r.totalReturnPct * 100).toFixed(1)}% ` +
        `sharpe=${r.sharpe.toFixed(2)} pf=${r.profitFactor.toFixed(2)} ` +
        `dd=${(r.maxDrawdownPct * 100).toFixed(1)}%  [${r.verdict}]`,
    );
  });

  console.log("\n=== TOP 10 OVERALL ===");
  rows.slice(0, 10).forEach((r) => {
    console.log(
      `  ${r.symbol} ${r.timeframe.padEnd(3)} ${r.mode.padEnd(15)} ` +
        `sharpe=${r.sharpe.toFixed(2)} ret=${(r.totalReturnPct * 100).toFixed(1)}% ` +
        `pf=${r.profitFactor.toFixed(2)} trades=${r.trades}  [${r.verdict}]`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
