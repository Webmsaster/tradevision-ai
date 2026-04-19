/**
 * Paper-Trade Report — read-only, prints accumulated stats.
 *
 *   node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts scripts/paperTradeReport.test.ts --reporter=verbose
 */
import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { computeStats, type PaperState } from "../src/utils/paperTradeLogger";

const STATE_FILE = join(homedir(), ".tradevision-ai", "paper-trades.json");

describe("Paper-Trade REPORT (read-only)", () => {
  it("print stats", () => {
    if (!existsSync(STATE_FILE)) {
      console.log(
        `\nNo paper-trade state yet at ${STATE_FILE}. Run paperTradeTick.test.ts first.`,
      );
      return;
    }
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PaperState;
    const stats = computeStats(state.closedTrades ?? []);

    console.log(`\n═══ Paper-Trade Report ═══`);
    console.log(`State file:     ${STATE_FILE}`);
    console.log(`Last tick:      ${state.lastTickAt ?? "—"}`);
    console.log(`Open positions: ${state.openPositions.length}`);
    console.log(`Closed trades:  ${state.closedTrades.length}`);

    if (stats.totalTrades === 0) {
      console.log(`\nNo closed trades yet. Keep ticking.`);
      return;
    }

    console.log(`\n─── Overall ───`);
    console.log(`  Trades       ${stats.totalTrades}`);
    console.log(
      `  WR           ${(stats.winRate * 100).toFixed(1)}%   (${stats.wins} wins / ${stats.losses} losses)`,
    );
    console.log(`  Net return   ${(stats.totalReturnPct * 100).toFixed(2)}%`);
    console.log(
      `  Avg return   ${(stats.avgReturnPct * 100).toFixed(3)}% per trade`,
    );
    console.log(`  Avg win      ${(stats.avgWinPct * 100).toFixed(2)}%`);
    console.log(`  Avg loss     ${(stats.avgLossPct * 100).toFixed(2)}%`);
    console.log(`  Profit factor ${stats.profitFactor.toFixed(2)}`);

    console.log(`\n─── By strategy ───`);
    for (const key of Object.keys(stats.byStrategy) as Array<
      keyof typeof stats.byStrategy
    >) {
      const x = stats.byStrategy[key];
      if (x.trades === 0) {
        console.log(`  ${String(key).padEnd(16)} (no trades yet)`);
        continue;
      }
      console.log(
        `  ${String(key).padEnd(16)} n=${x.trades.toString().padStart(4)}  WR ${(x.wr * 100).toFixed(1).padStart(5)}%  sumRet ${(x.ret * 100).toFixed(2)}%`,
      );
    }

    console.log(`\n─── Recent closes (last 10) ───`);
    const recent = [...state.closedTrades].slice(-10).reverse();
    for (const t of recent) {
      console.log(
        `  ${t.exitTime.slice(0, 16)} ${t.strategy.padEnd(16)} ${t.symbol.padEnd(10)} ${t.direction.padEnd(5)} ${t.exitReason.padEnd(10)} net=${(t.netPnlPct * 100).toFixed(2).padStart(6)}%`,
      );
    }

    // Backtest vs live comparison
    console.log(`\n─── Backtest-vs-Paper (target) ───`);
    const bt: Record<string, { wr: number; note: string }> = {
      "hf-daytrading": {
        wr: 0.903,
        note: "iter57 medWR 90.3% (minWR 85%)",
      },
      "hi-wr-1h": {
        wr: 0.777,
        note: "iter53 medWR 77.7% (minWR 71.8%)",
      },
      "vol-spike-1h": {
        wr: 0.5,
        note: "iter34 WR 40-55% but high Sharpe",
      },
    };
    for (const key of Object.keys(stats.byStrategy) as Array<
      keyof typeof stats.byStrategy
    >) {
      const live = stats.byStrategy[key];
      if (live.trades < 5) {
        console.log(
          `  ${String(key).padEnd(16)} too few trades (${live.trades}) for fair comparison`,
        );
        continue;
      }
      const target = bt[key as string];
      const gap = (live.wr - target.wr) * 100;
      const flag = gap >= -10 ? "✓" : gap >= -20 ? "⚠" : "✗";
      console.log(
        `  ${flag} ${String(key).padEnd(16)} live WR ${(live.wr * 100).toFixed(1)}%  vs backtest ${(target.wr * 100).toFixed(1)}%  gap ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp  (${target.note})`,
      );
    }
  });
});
