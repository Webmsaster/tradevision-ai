/**
 * Paper-Trade Daily Report — reads state + posts to Discord/Slack webhook.
 *
 * Run via cron once per day, e.g. 00:01 UTC:
 *   1 0 * * * cd /path/to/repo && DISCORD_WEBHOOK_URL=... npm run paper:daily-report
 *
 * Also flags edge-degradation: if 7-day rolling live WR is >10pp below the
 * backtest min (STRATEGY_EDGE_STATS[*].winRate), warn in the embed.
 */
import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { computeStats, type PaperState } from "../src/utils/paperTradeLogger";
import { STRATEGY_EDGE_STATS } from "../src/utils/positionSizing";
import {
  formatDailyReport,
  rollingWr,
  sendDiscordWebhook,
  sendSlackWebhook,
} from "../src/utils/paperNotifications";

const STATE_FILE = join(homedir(), ".tradevision-ai", "paper-trades.json");

describe("Paper-Trade DAILY REPORT (webhook-enabled)", () => {
  it(
    "compute stats + post to webhooks if configured",
    { timeout: 30_000 },
    async () => {
      if (!existsSync(STATE_FILE)) {
        console.log(
          `No state at ${STATE_FILE}. Nothing to report. Run paper:tick first.`,
        );
        return;
      }
      const state: PaperState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      const stats = computeStats(state.closedTrades ?? []);

      if (stats.totalTrades === 0) {
        console.log("No closed trades yet — skipping webhook.");
        return;
      }

      // Build 7-day rolling + backtest comparison
      const rolling = rollingWr(state.closedTrades, new Date(), 7);
      const backtest: Record<string, number> = {};
      for (const [k, s] of Object.entries(STRATEGY_EDGE_STATS)) {
        backtest[k] = s.winRate;
      }

      const payload = formatDailyReport({
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        totalReturnPct: stats.totalReturnPct,
        byStrategy: stats.byStrategy,
        rolling7dWr: rolling,
        backtestWr: backtest,
      });

      console.log(`\n${payload.title}\n${payload.body}\n`);

      const discord = process.env.DISCORD_WEBHOOK_URL ?? "";
      const slack = process.env.SLACK_WEBHOOK_URL ?? "";

      if (discord) {
        const ok = await sendDiscordWebhook(discord, payload);
        console.log(`Discord: ${ok ? "sent ✓" : "failed ✗"}`);
      }
      if (slack) {
        const ok = await sendSlackWebhook(slack, payload);
        console.log(`Slack: ${ok ? "sent ✓" : "failed ✗"}`);
      }
      if (!discord && !slack) {
        console.log(
          "No webhook env configured (DISCORD_WEBHOOK_URL / SLACK_WEBHOOK_URL). Report printed to stdout only.",
        );
      }
    },
  );
});
