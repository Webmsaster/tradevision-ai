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

// Round 56 (Fix 4): match the convention in /api/webhook-test/route.ts —
// 5s AbortSignal.timeout caps each webhook call so a hung Discord/Slack
// endpoint can't stall the tick loop.
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Strips path/query so logs only show the host (no leaked tokens). Falls
 * back to a generic placeholder if the URL is unparseable.
 */
function redactWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<malformed-url>";
  }
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
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Round 56 (Fix 6): surface non-2xx so silent failures show in logs.
      console.warn(
        "[paper-notify] discord webhook non-2xx:",
        redactWebhookUrl(url),
        res.status,
      );
    }
    return res.ok;
  } catch (err) {
    // Round 56 (Fix 6): the previous bare catch{} swallowed all failures —
    // including AbortSignal timeouts — so the user never knew a webhook
    // was broken. Log host only (token is in the URL path/query).
    console.warn(
      "[paper-notify] discord webhook failed:",
      redactWebhookUrl(url),
      err instanceof Error ? err.message : err,
    );
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
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        "[paper-notify] slack webhook non-2xx:",
        redactWebhookUrl(url),
        res.status,
      );
    }
    return res.ok;
  } catch (err) {
    console.warn(
      "[paper-notify] slack webhook failed:",
      redactWebhookUrl(url),
      err instanceof Error ? err.message : err,
    );
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
