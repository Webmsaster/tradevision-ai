/**
 * Telegram Bot — long-polling command receiver.
 *
 * Implements interactive commands: /status, /positions, /pnl, /pause,
 * /resume, /kill, /help.
 *
 * Writes control flags to bot-controls.json that the Python executor
 * reads on each loop. Reads state from ftmo-state/ JSON files to answer
 * info queries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  tgSend,
  readTelegramConfig,
  htmlEscape,
  type TelegramConfig,
} from "./telegramNotify";

export interface BotControls {
  paused: boolean;
  killRequested: boolean;
  lastCommand?: { from: string; cmd: string; ts: string };
}

export interface TelegramCommandHandlerCtx {
  stateDir: string;
  challengeStartBalance: number;
}

const POLL_TIMEOUT_SEC = 25;
let lastUpdateId = 0;

export async function startTelegramBot(ctx: TelegramCommandHandlerCtx) {
  const cfg = readTelegramConfig();
  if (!cfg) {
    console.log(
      "[tg-bot] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — bot commands disabled",
    );
    return;
  }
  console.log(
    `[tg-bot] command receiver starting (long-poll every ${POLL_TIMEOUT_SEC}s)`,
  );
  await tgSend(
    `🤖 <b>Bot Commands Active</b>\nSend <code>/help</code> for available commands.`,
    cfg,
  );
  pollLoop(cfg, ctx);
}

async function pollLoop(cfg: TelegramConfig, ctx: TelegramCommandHandlerCtx) {
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${cfg.token}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${lastUpdateId + 1}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[tg-bot] HTTP ${resp.status}`);
        await sleep(5000);
        continue;
      }
      const body = (await resp.json()) as { ok: boolean; result: TgUpdate[] };
      if (!body.ok || !body.result) {
        await sleep(5000);
        continue;
      }
      for (const upd of body.result) {
        lastUpdateId = Math.max(lastUpdateId, upd.update_id);
        if (upd.message?.text) {
          await handleCommand(upd.message, cfg, ctx);
        }
      }
    } catch (e) {
      console.error(`[tg-bot] poll error:`, e);
      await sleep(5000);
    }
  }
}

async function handleCommand(
  msg: TgMessage,
  cfg: (TelegramCommandHandlerCtx & TelegramConfig) | TelegramConfig,
  ctx: TelegramCommandHandlerCtx,
) {
  // Only respond to messages from configured chat ID
  if (String(msg.chat.id) !== cfg.chatId) return;
  const text = msg.text.trim();
  if (!text.startsWith("/")) return;
  const cmd = text.split(/\s+/)[0].toLowerCase().split("@")[0]; // strip @botname
  const from = msg.from?.username || msg.from?.first_name || "user";
  console.log(`[tg-bot] ${from}: ${cmd}`);

  switch (cmd) {
    case "/help":
    case "/start":
      await tgSend(helpText(), cfg);
      break;
    case "/status":
      await tgSend(await renderStatus(ctx), cfg);
      break;
    case "/positions":
      await tgSend(await renderPositions(ctx), cfg);
      break;
    case "/pnl":
      await tgSend(await renderPnl(ctx), cfg);
      break;
    case "/pause":
      setControls(ctx.stateDir, {
        paused: true,
        lastCommand: { from, cmd, ts: new Date().toISOString() },
      });
      await tgSend(
        "⏸ <b>Bot PAUSED</b>\nNew signals will be skipped.\nOpen positions continue (use /kill to close).",
        cfg,
      );
      break;
    case "/resume":
      setControls(ctx.stateDir, {
        paused: false,
        lastCommand: { from, cmd, ts: new Date().toISOString() },
      });
      await tgSend("▶️ <b>Bot RESUMED</b>\nNew signals will be executed.", cfg);
      break;
    case "/kill":
      setControls(ctx.stateDir, {
        killRequested: true,
        paused: true,
        lastCommand: { from, cmd, ts: new Date().toISOString() },
      });
      await tgSend(
        "🛑 <b>KILL REQUESTED</b>\nExecutor will close all open positions on next poll (~30s) and pause.\nUse /resume to re-enable after.",
        cfg,
      );
      break;
    case "/config":
      await tgSend(await renderConfig(ctx), cfg);
      break;
    case "/trades":
      await tgSend(renderTrades(ctx), cfg);
      break;
    case "/stats":
      await tgSend(renderStats(ctx), cfg);
      break;
    case "/preview":
      await tgSend(renderPreview(ctx), cfg);
      break;
    default:
      await tgSend(
        `❓ Unknown command: <code>${htmlEscape(cmd)}</code>\nSend /help for options.`,
        cfg,
      );
  }
}

function helpText() {
  return [
    "<b>Available commands</b>",
    "",
    "<code>/status</code> — current equity, day, service health",
    "<code>/positions</code> — list open positions",
    "<code>/pnl</code> — today's + recent P&L summary",
    "<code>/trades</code> — last 10 closed trades",
    "<code>/stats</code> — win-rate, avg trade, days to pass",
    "<code>/preview</code> — what would next check do?",
    "<code>/pause</code> — skip new signals (open positions continue)",
    "<code>/resume</code> — re-enable new signals",
    "<code>/kill</code> — close all open positions + pause",
    "<code>/config</code> — show active bot config",
    "<code>/help</code> — this message",
  ].join("\n");
}

async function renderStatus(ctx: TelegramCommandHandlerCtx): Promise<string> {
  const acc = readJson<{
    equity?: number;
    day?: number;
    raw_equity_usd?: number;
    raw_balance_usd?: number;
    updated_at?: string;
  }>(path.join(ctx.stateDir, "account.json"), {});
  const status = readJson<{ ts?: string; nextCheckInSec?: number }>(
    path.join(ctx.stateDir, "service-status.json"),
    {},
  );
  const controls = readControls(ctx.stateDir);
  const lastCheck = readJson<{ signalCount?: number; timestamp?: number }>(
    path.join(ctx.stateDir, "last-check.json"),
    {},
  );

  const equityPct =
    acc.equity !== undefined ? ((acc.equity - 1) * 100).toFixed(2) + "%" : "?";
  const equityUsd =
    acc.raw_equity_usd !== undefined
      ? `$${acc.raw_equity_usd.toLocaleString()}`
      : "?";
  const lastCheckAgo = lastCheck.timestamp
    ? Math.round((Date.now() - lastCheck.timestamp) / 60000) + "min"
    : "never";
  const serviceAgo = status.ts
    ? Math.round((Date.now() - new Date(status.ts).getTime()) / 1000) + "s"
    : "?";

  return [
    "<b>📊 Status</b>",
    "",
    `Equity: <b>${equityPct}</b> (${equityUsd})`,
    `Day: <b>${(acc.day ?? 0) + 1}/30</b>`,
    `Paused: <b>${controls.paused ? "YES ⏸" : "no ▶️"}</b>`,
    `Last signal check: ${lastCheckAgo} ago (found ${lastCheck.signalCount ?? 0})`,
    `Service heartbeat: ${serviceAgo} ago`,
    `Next check in: ${status.nextCheckInSec ?? "?"}s`,
  ].join("\n");
}

async function renderPositions(
  ctx: TelegramCommandHandlerCtx,
): Promise<string> {
  const data = readJson<{
    positions: Array<{
      ticket: number;
      signalAsset: string;
      entry_price: number;
      lot: number;
      opened_at: string;
      max_hold_until: number;
    }>;
  }>(path.join(ctx.stateDir, "open-positions.json"), { positions: [] });
  if (!data.positions.length) return "📭 <b>No open positions</b>";
  const lines = ["<b>📈 Open Positions</b>", ""];
  for (const p of data.positions) {
    const holdLeft = Math.max(
      0,
      Math.round((p.max_hold_until - Date.now()) / 60000),
    );
    lines.push(
      `<b>${p.signalAsset}</b> #${p.ticket}\n` +
        `  ${p.lot} lot @ $${p.entry_price.toFixed(4)}\n` +
        `  opened ${new Date(p.opened_at).toISOString().slice(11, 16)}Z · hold left: ${holdLeft}min`,
    );
  }
  return lines.join("\n\n");
}

async function renderPnl(ctx: TelegramCommandHandlerCtx): Promise<string> {
  const acc = readJson<{
    equity?: number;
    equityAtDayStart?: number;
    raw_equity_usd?: number;
  }>(path.join(ctx.stateDir, "account.json"), {});
  const daily = readJson<{ date?: string; equity_at_day_start_usd?: number }>(
    path.join(ctx.stateDir, "daily-reset.json"),
    {},
  );
  if (!acc.equity) return "ℹ️ <b>No account data yet</b>";

  const totalEq = ((acc.equity - 1) * 100).toFixed(2);
  const dailyStart = acc.equityAtDayStart ?? 1;
  const dailyPct = (((acc.equity - dailyStart) / dailyStart) * 100).toFixed(2);
  const dailyUsd =
    acc.raw_equity_usd && daily.equity_at_day_start_usd
      ? (acc.raw_equity_usd - daily.equity_at_day_start_usd).toFixed(2)
      : "?";

  return [
    "<b>💰 P&L Summary</b>",
    "",
    `<b>Today</b> (${daily.date ?? "?"})`,
    `  ${dailyPct}% · $${dailyUsd}`,
    "",
    `<b>Total challenge</b>`,
    `  ${totalEq}%`,
    `  Equity: $${acc.raw_equity_usd?.toLocaleString() ?? "?"}`,
  ].join("\n");
}

async function renderConfig(ctx: TelegramCommandHandlerCtx): Promise<string> {
  return [
    "<b>⚙️ Bot Config</b>",
    "",
    `Strategy: <b>iter231</b> (Kelly-enhanced)`,
    `Assets: ETH + BTC + SOL (4h timeframe)`,
    `Stop: 1.0% · TP: 2.2% · Hold: 24h`,
    `Direction: SHORT only (mean-reversion)`,
    `Pyramid: ETH 5× @ +0.3% equity`,
    `Delayed assets: BTC+SOL unlock at +4% equity`,
    `FTMO rules: max daily 5%, max total 10%`,
    "",
    `Start balance: $${ctx.challengeStartBalance.toLocaleString()}`,
    `State dir: <code>${htmlEscape(ctx.stateDir)}</code>`,
  ].join("\n");
}

// ---- Controls file ----
const CONTROLS_FILE = "bot-controls.json";

export function readControls(stateDir: string): BotControls {
  return readJson<BotControls>(path.join(stateDir, CONTROLS_FILE), {
    paused: false,
    killRequested: false,
  });
}

function setControls(stateDir: string, update: Partial<BotControls>) {
  const current = readControls(stateDir);
  const next = { ...current, ...update };
  // BUGFIX 2026-04-28: PID-suffixed tmp prevents cross-process race
  // (Node and Python both write to bot-controls.json — bare .tmp would clash).
  const target = path.join(stateDir, CONTROLS_FILE);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, target);
}

// ---- IO ----
function readJson<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExecutedEntry {
  signal?: {
    assetSymbol?: string;
    signalBarClose?: number;
    entryPrice?: number;
    direction?: string;
  };
  result?: string;
  ticket?: number;
  actual_entry?: number;
  lot?: number;
  ts?: string;
  error?: string;
  reason?: string;
}

function readExecuted(stateDir: string): ExecutedEntry[] {
  const data = readJson<{ executions?: ExecutedEntry[] }>(
    path.join(stateDir, "executed-signals.json"),
    {},
  );
  return data.executions ?? [];
}

function readAccount(stateDir: string) {
  return readJson<{
    equity?: number;
    day?: number;
    raw_equity_usd?: number;
    recentPnls?: number[];
    equityAtDayStart?: number;
  }>(path.join(stateDir, "account.json"), {});
}

function renderTrades(ctx: TelegramCommandHandlerCtx): string {
  const executed = readExecuted(ctx.stateDir);
  const placed = executed
    .filter((e) => e.result === "placed")
    .slice(-10)
    .reverse();
  if (placed.length === 0) return "📋 <b>No trades yet</b>";
  const lines = ["📋 <b>Last 10 trades</b>", ""];
  for (const e of placed) {
    const ts = e.ts
      ? new Date(e.ts).toISOString().slice(5, 16).replace("T", " ")
      : "?";
    const sym = e.signal?.assetSymbol ?? "?";
    const px = e.actual_entry?.toFixed(2) ?? "?";
    const lot = e.lot?.toFixed(3) ?? "?";
    lines.push(
      `<code>${ts}</code> ${sym} @ $${px} × ${lot} lot (#${e.ticket ?? "?"})`,
    );
  }
  return lines.join("\n");
}

function renderStats(ctx: TelegramCommandHandlerCtx): string {
  const acc = readAccount(ctx.stateDir);
  const recent = acc.recentPnls ?? [];
  const eq = acc.equity ?? 1.0;
  const day = acc.day ?? 0;
  if (recent.length === 0)
    return (
      "📊 <b>No closed trades yet</b>\nDay " +
      day +
      " of 30 · equity " +
      ((eq - 1) * 100).toFixed(2) +
      "%"
    );
  const wins = recent.filter((p) => p > 0).length;
  const winRate = wins / recent.length;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const best = Math.max(...recent);
  const worst = Math.min(...recent);
  const sumWins = recent.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const sumLoss = Math.abs(
    recent.filter((p) => p < 0).reduce((a, b) => a + b, 0),
  );
  const pf = sumLoss > 0 ? (sumWins / sumLoss).toFixed(2) : "∞";
  // Rough days-to-pass estimate from current velocity
  const eqGain = eq - 1;
  const remaining = 0.1 - eqGain;
  const velocity = day > 0 ? eqGain / day : 0;
  const daysToPass =
    velocity > 0 && remaining > 0
      ? (remaining / velocity).toFixed(1) + "d"
      : "—";
  return [
    "📊 <b>Bot Statistics</b>",
    "",
    `<b>Trades:</b> ${recent.length} (last 20)`,
    `<b>Win-rate:</b> ${(winRate * 100).toFixed(0)}% (${wins}/${recent.length})`,
    `<b>Avg trade:</b> ${(avg * 100).toFixed(3)}%`,
    `<b>Best:</b> ${(best * 100).toFixed(2)}%  Worst: ${(worst * 100).toFixed(2)}%`,
    `<b>Profit Factor:</b> ${pf}`,
    "",
    `<b>Equity:</b> ${(eqGain * 100).toFixed(2)}% (target +10%)`,
    `<b>Day:</b> ${day} of 30`,
    `<b>Velocity:</b> ${(velocity * 100).toFixed(2)}%/day`,
    `<b>ETA to target:</b> ${daysToPass}`,
  ].join("\n");
}

function renderPreview(ctx: TelegramCommandHandlerCtx): string {
  const last = readJson<{
    timestamp?: number;
    regime?: string;
    signalCount?: number;
    notes?: string[];
    skipped?: Array<{ asset: string; reason: string }>;
    btc?: { close: number; ema10: number; ema15: number; mom24h: number };
  }>(path.join(ctx.stateDir, "last-check.json"), {});
  if (!last.timestamp) return "🔍 <b>No check performed yet</b>";
  const age = Date.now() - last.timestamp;
  const ageMin = Math.round(age / 60000);
  const lines = [`🔍 <b>Last Check</b> (${ageMin}m ago)`, ""];
  if (last.regime) lines.push(`Regime: <b>${last.regime}</b>`);
  if (last.btc) {
    const trend =
      last.btc.close > last.btc.ema10 && last.btc.ema10 > last.btc.ema15
        ? "↑"
        : "↓";
    lines.push(
      `BTC: $${last.btc.close.toFixed(0)} ${trend} 24h: ${(last.btc.mom24h * 100).toFixed(2)}%`,
    );
  }
  lines.push(`Signals found: <b>${last.signalCount ?? 0}</b>`);
  if (last.skipped && last.skipped.length > 0) {
    lines.push("\n<b>Skipped:</b>");
    for (const s of last.skipped.slice(0, 6)) {
      lines.push(`  ${s.asset}: ${s.reason}`);
    }
  }
  if (last.notes && last.notes.length > 0) {
    lines.push("\n<b>Notes:</b>");
    for (const n of last.notes.slice(0, 5)) lines.push(`  ${n}`);
  }
  return lines.join("\n");
}

// ---- Types ----
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text: string;
}
