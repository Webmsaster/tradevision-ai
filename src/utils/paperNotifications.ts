/**
 * Paper-Trade Notifications — formatters for desktop (notify-send) + webhooks
 * (Discord/Slack). Called from the tick script after positions open/close.
 *
 * All functions are pure (no side effects) so they're easy to unit-test.
 * The actual OS-level send happens in the .sh wrapper or via fetch() call.
 */
import type { PaperPosition, ClosedTrade } from "@/utils/paperTradeLogger";

export interface NotificationPayload {
  title: string;
  body: string;
  /** Discord-style embed color (decimal). Green=3066993, Red=15158332, Orange=15105570, Blue=3447003. */
  color: number;
}

export function formatOpenedPosition(
  position: PaperPosition,
  notional: number,
): NotificationPayload {
  const dir = position.direction.toUpperCase();
  const color = position.direction === "long" ? 3066993 : 15158332;
  const title = `📈 OPEN ${position.strategy} ${position.symbol} ${dir}`;
  const lines = [
    `Entry: $${position.entry.toFixed(4)}`,
    `Stop:  $${position.stop.toFixed(4)}`,
  ];
  if (position.tp1) lines.push(`TP1:   $${position.tp1.toFixed(4)} (50% exit)`);
  if (position.tp2)
    lines.push(`TP2:   $${position.tp2.toFixed(4)} (remainder)`);
  lines.push(`Size:  $${notional.toFixed(0)} notional`);
  lines.push(`Hold:  until ${position.holdUntil.slice(11, 16)} UTC`);
  return { title, body: lines.join("\n"), color };
}

export function formatClosedTrade(trade: ClosedTrade): NotificationPayload {
  const pnlPct = trade.netPnlPct * 100;
  const icon = pnlPct > 0 ? "✅" : pnlPct < 0 ? "❌" : "⚪";
  const color = pnlPct > 0 ? 3066993 : pnlPct < 0 ? 15158332 : 9807270;
  const title = `${icon} CLOSE ${trade.strategy} ${trade.symbol} ${trade.direction.toUpperCase()}`;
  const lines = [
    `Reason:  ${trade.exitReason}`,
    `Entry:   $${trade.entry.toFixed(4)}`,
    `Exit:    $${trade.exit.toFixed(4)}`,
    `Net PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
  ];
  return { title, body: lines.join("\n"), color };
}

export interface DailyReportInput {
  totalTrades: number;
  winRate: number;
  totalReturnPct: number;
  byStrategy: Record<
    string,
    { trades: number; wins: number; wr: number; ret: number }
  >;
  /** Last 7-day rolling WR per strategy. */
  rolling7dWr?: Record<string, number>;
  /** Backtest reference WR per strategy (from STRATEGY_EDGE_STATS). */
  backtestWr?: Record<string, number>;
}

export function formatDailyReport(
  input: DailyReportInput,
): NotificationPayload {
  const wrPct = (input.winRate * 100).toFixed(1);
  const retPct = (input.totalReturnPct * 100).toFixed(2);
  const lines = [
    `Trades: ${input.totalTrades}  WR: ${wrPct}%  Return: ${retPct >= "0" ? "+" : ""}${retPct}%`,
    "",
    "Per strategy:",
  ];
  let hasDegradation = false;
  for (const [key, x] of Object.entries(input.byStrategy)) {
    if (x.trades === 0) continue;
    const rolling = input.rolling7dWr?.[key];
    const backtest = input.backtestWr?.[key];
    let flag = "";
    if (rolling !== undefined && backtest !== undefined) {
      const gap = (rolling - backtest) * 100;
      if (gap < -10) {
        flag = ` ⚠️ 7d WR ${(rolling * 100).toFixed(1)}% vs backtest ${(backtest * 100).toFixed(1)}% (gap ${gap.toFixed(1)}pp)`;
        hasDegradation = true;
      } else if (gap < -5) {
        flag = ` ⚡ 7d WR ${(rolling * 100).toFixed(1)}% drifting`;
      }
    }
    lines.push(
      `  ${key.padEnd(16)} n=${x.trades}  WR ${(x.wr * 100).toFixed(1)}%  ret ${(x.ret * 100).toFixed(1)}%${flag}`,
    );
  }
  const color = hasDegradation ? 15158332 : 3066993;
  return {
    title: hasDegradation
      ? "⚠️ Paper-Trade Daily Report — EDGE DEGRADATION DETECTED"
      : "📊 Paper-Trade Daily Report",
    body: lines.join("\n"),
    color,
  };
}

/**
 * POSTs a notification to a Discord webhook. Returns true on success.
 * Silent no-op if url is empty (lets the tick continue without error).
 */
export async function sendDiscordWebhook(
  url: string,
  p: NotificationPayload,
): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: p.title,
            description: p.body,
            color: p.color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POSTs to a Slack webhook. Uses blocks for formatting.
 */
export async function sendSlackWebhook(
  url: string,
  p: NotificationPayload,
): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: p.title,
        blocks: [
          { type: "header", text: { type: "plain_text", text: p.title } },
          {
            type: "section",
            text: { type: "mrkdwn", text: "```\n" + p.body + "\n```" },
          },
        ],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Compute 7-day-rolling WR per strategy from closed trades.
 * `now` and `closedTrades` must be provided; the window is [now - 7d, now].
 */
export function rollingWr(
  closedTrades: Array<{
    strategy: string;
    netPnlPct: number;
    exitTime: string;
  }>,
  now: Date = new Date(),
  windowDays = 7,
): Record<string, number> {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const recent = closedTrades.filter(
    (t) => new Date(t.exitTime).getTime() >= cutoff,
  );
  const byStrat: Record<string, { wins: number; total: number }> = {};
  for (const t of recent) {
    const b = byStrat[t.strategy] ?? { wins: 0, total: 0 };
    b.total++;
    if (t.netPnlPct > 0) b.wins++;
    byStrat[t.strategy] = b;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byStrat)) {
    out[k] = v.total > 0 ? v.wins / v.total : 0;
  }
  return out;
}
