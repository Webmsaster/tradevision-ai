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

// BUGFIX 2026-04-28 (Round 27): lastUpdateId persisted per-stateDir to survive
// restarts. Was a module-global, which on PM2 restart re-pulled the
// last 24h of updates and re-fired stale /pause / /kill commands.
function lastUpdateIdPath(stateDir: string): string {
  return path.join(stateDir, "telegram-update-id.json");
}

function readLastUpdateId(stateDir: string): number {
  try {
    const p = lastUpdateIdPath(stateDir);
    if (!fs.existsSync(p)) return 0;
    const obj = JSON.parse(fs.readFileSync(p, "utf-8")) as { id?: number };
    return Number.isFinite(obj.id) ? Number(obj.id) : 0;
  } catch {
    return 0;
  }
}

function writeLastUpdateId(stateDir: string, id: number): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const p = lastUpdateIdPath(stateDir);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ id }));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error(`[tg-bot] failed to persist lastUpdateId:`, e);
  }
}

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
  // BUGFIX 2026-04-28 (Round 18): exp-backoff on consecutive errors.
  let consecutiveErrors = 0;
  let lastUpdateId = readLastUpdateId(ctx.stateDir);
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${cfg.token}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${lastUpdateId + 1}`;
      // BUGFIX 2026-04-28 (Round 18): timeout (Telegram long-poll = 25s + 10s buffer).
      const resp = await fetch(url, {
        signal: AbortSignal.timeout((POLL_TIMEOUT_SEC + 10) * 1000),
      });
      if (!resp.ok) {
        // Round 18: don't log full URL (contains token). Only status + retry-after.
        const retryAfter =
          resp.status === 429
            ? Number(resp.headers.get("Retry-After") || 5)
            : 5;
        console.error(`[tg-bot] HTTP ${resp.status} (retry in ${retryAfter}s)`);
        // 401/404 = invalid token / chat gone — exit loop.
        if (resp.status === 401 || resp.status === 404) {
          console.error(
            `[tg-bot] fatal status ${resp.status} — exiting poll loop`,
          );
          return;
        }
        consecutiveErrors++;
        const backoff = Math.min(
          60_000,
          retryAfter * 1000 * Math.pow(2, Math.min(consecutiveErrors - 1, 4)),
        );
        await sleep(backoff);
        continue;
      }
      consecutiveErrors = 0;
      const body = (await resp.json()) as { ok: boolean; result: TgUpdate[] };
      if (!body.ok || !body.result) {
        await sleep(5000);
        continue;
      }
      let updatedId = false;
      for (const upd of body.result) {
        if (upd.update_id > lastUpdateId) {
          lastUpdateId = upd.update_id;
          updatedId = true;
        }
        // BUGFIX 2026-04-28 (Round 18): also handle edited_message.
        const msg = upd.message ?? (upd as any).edited_message;
        if (msg?.text) {
          try {
            await handleCommand(msg, cfg, ctx);
          } catch (cmdErr) {
            console.error(`[tg-bot] command handler error:`, cmdErr);
          }
        }
      }
      // BUGFIX 2026-04-28 (Round 27): persist update-id between batches so
      // restarts don't re-process old commands.
      if (updatedId) writeLastUpdateId(ctx.stateDir, lastUpdateId);
    } catch (e) {
      // Don't dump full error (may include URL/token).
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[tg-bot] poll error: ${msg}`);
      consecutiveErrors++;
      const backoff = Math.min(
        60_000,
        5_000 * Math.pow(2, Math.min(consecutiveErrors - 1, 3)),
      );
      await sleep(backoff);
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
  // Phase 23 (Auth Bug 2): optional user-id whitelist via env. If the chat
  // is a group / channel, anyone in there could fire /kill. With a token
  // leak this is the second line of defence.
  const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    allowedUserIds.length > 0 &&
    !allowedUserIds.includes(String(msg.from?.id ?? ""))
  ) {
    console.warn(
      `[tg-bot] denied cmd from unauthorized user id=${msg.from?.id}`,
    );
    return;
  }
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
    // Round-7 #5: signalAsset and opened_at originate from open-positions.json,
    // which is writable by the Python executor and could in principle contain
    // stray HTML — escape every interpolated string before sending to TG.
    const safeAsset = htmlEscape(String(p.signalAsset ?? "?"));
    // BUGFIX 2026-04-28 (Round 27): guard invalid date strings — would crash
    // entire handler with no outer catch.
    let safeOpened = "?";
    try {
      const d = new Date(p.opened_at);
      if (!Number.isNaN(d.getTime())) {
        safeOpened = htmlEscape(d.toISOString().slice(11, 16) + "Z");
      }
    } catch {
      // ignore — keep "?"
    }
    lines.push(
      `<b>${safeAsset}</b> #${p.ticket}\n` +
        `  ${p.lot} lot @ $${p.entry_price.toFixed(4)}\n` +
        `  opened ${safeOpened} · hold left: ${holdLeft}min`,
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
  // BUGFIX 2026-04-28 (Round 27): equity===0 (total loss) is legitimate but
  // !acc.equity rejects it. Use explicit undefined check.
  if (acc.equity === undefined) return "ℹ️ <b>No account data yet</b>";

  const totalEq = ((acc.equity - 1) * 100).toFixed(2);
  // BUGFIX 2026-04-28 (Round 27): guard divide-by-zero if equityAtDayStart corrupt.
  const dailyStart =
    acc.equityAtDayStart && acc.equityAtDayStart > 0 ? acc.equityAtDayStart : 1;
  const dailyPct = (((acc.equity - dailyStart) / dailyStart) * 100).toFixed(2);
  const dailyUsd =
    acc.raw_equity_usd && daily.equity_at_day_start_usd
      ? (acc.raw_equity_usd - daily.equity_at_day_start_usd).toFixed(2)
      : "?";

  // Round-7 #5: daily.date originates from JSON state file — escape before send.
  const safeDate = htmlEscape(String(daily.date ?? "?"));
  return [
    "<b>💰 P&L Summary</b>",
    "",
    `<b>Today</b> (${safeDate})`,
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
  // BUGFIX 2026-04-28 (Round 36 Bug 5/7): R-M-W under file lock matches
  // Python's update_controls() helper. Was: re-read merge — best-effort
  // only; Python's concurrent flag write between our read and rename
  // could still be lost. Now: blocking flock around read+write so the
  // two processes can't interleave their R-M-W on bot-controls.json.
  withControlsLock(stateDir, () => {
    const beforeWrite = readControls(stateDir) as BotControls & {
      orderFailStreak?: number;
      lastOrderFailError?: string;
    };
    const merged = { ...beforeWrite, ...update };
    const target = path.join(stateDir, CONTROLS_FILE);
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, target);
  });
}

/**
 * Blocking-ish exclusive lock on bot-controls.json. Uses an O_CREAT|O_EXCL
 * sentinel file polled with backoff. Not perfect (no kernel-level flock from
 * Node without native deps) but good enough — the lock is held for ~ms.
 */
function withControlsLock(stateDir: string, fn: () => void): void {
  const lockPath = path.join(stateDir, "bot-controls.lock");
  const startMs = Date.now();
  const maxWaitMs = 2_000; // 2s upper bound — beyond this, assume stale
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      try {
        fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* lock file may already be gone */
        }
      }
      return;
    } catch (e: unknown) {
      // Lock held by another process. If it's been there >2s, assume the
      // holder crashed and force-take it.
      if (Date.now() - startMs > maxWaitMs) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* nothing to clear */
        }
        // Loop will retry the openSync next iteration.
      }
      // Tiny backoff (sync — function is called from async context but
      // total runtime here is bounded by maxWaitMs).
      const until = Date.now() + 5;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
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
    // Round-7 #5: assetSymbol from executed.json is user-controllable via the
    // Python executor — escape before HTML send.
    const sym = htmlEscape(String(e.signal?.assetSymbol ?? "?"));
    const px = e.actual_entry?.toFixed(2) ?? "?";
    const lot = e.lot?.toFixed(3) ?? "?";
    lines.push(
      `<code>${htmlEscape(ts)}</code> ${sym} @ $${px} × ${lot} lot (#${e.ticket ?? "?"})`,
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
  // Round-7 #5: regime/asset/reason/notes originate from last-check.json which
  // is written by the signal service — escape every interpolation.
  if (last.regime) lines.push(`Regime: <b>${htmlEscape(last.regime)}</b>`);
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
      lines.push(
        `  ${htmlEscape(String(s.asset ?? "?"))}: ${htmlEscape(String(s.reason ?? "?"))}`,
      );
    }
  }
  if (last.notes && last.notes.length > 0) {
    lines.push("\n<b>Notes:</b>");
    for (const n of last.notes.slice(0, 5)) lines.push(`  ${htmlEscape(n)}`);
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
