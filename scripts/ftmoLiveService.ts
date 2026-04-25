/**
 * FTMO Live Signal Service — long-running process.
 *
 * Runs on user's VPS / PC 24/7. Every 4h (00/04/08/12/16/20 UTC) it:
 *   1. Fetches latest ETH+BTC+SOL 4h candles from Binance
 *   2. Reads current account state from state/account.json (written by executor)
 *   3. Calls detectLiveSignalsV231
 *   4. Appends new signals to state/pending-signals.json
 *   5. Logs everything to state/signal-log.jsonl
 *
 * The Python MT5 executor reads state/pending-signals.json and places orders.
 * It writes back state/executed-signals.json and state/account.json.
 *
 * Usage:
 *   node ./node_modules/tsx/dist/cli.mjs scripts/ftmoLiveService.ts
 *   (or via pm2 / systemd for 24/7 operation — see tools/README-ftmo-bot.md)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  detectLiveSignalsV231,
  renderDetection,
  type AccountState,
  type DetectionResult,
  type LiveSignal,
} from "../src/utils/ftmoLiveSignalV231";
import type { Candle } from "../src/utils/indicators";
import { tgSend, htmlEscape } from "../src/utils/telegramNotify";
import { startTelegramBot, readControls } from "../src/utils/telegramBot";
import {
  loadForexFactoryNews,
  filterNewsEvents,
  type NewsEvent,
} from "../src/utils/forexFactoryNews";

const TF: "1h" | "2h" | "4h" =
  process.env.FTMO_TF === "1h"
    ? "1h"
    : process.env.FTMO_TF === "2h"
      ? "2h"
      : "4h";
const TF_HOURS = TF === "1h" ? 1 : TF === "2h" ? 2 : 4;
const STATE_DIR =
  process.env.FTMO_STATE_DIR ?? path.join(process.cwd(), `ftmo-state-${TF}`);
const PENDING_PATH = path.join(STATE_DIR, "pending-signals.json");
const EXECUTED_PATH = path.join(STATE_DIR, "executed-signals.json");
const ACCOUNT_PATH = path.join(STATE_DIR, "account.json");
const LOG_PATH = path.join(STATE_DIR, "signal-log.jsonl");
const LAST_CHECK_PATH = path.join(STATE_DIR, "last-check.json");
const NEWS_PATH = path.join(STATE_DIR, "news-events.json");
const ALERTS_STATE_PATH = path.join(STATE_DIR, "alerts-state.json");

/** News events list cached for the session (refreshed once per hour). */
let cachedNews: NewsEvent[] = [];
let newsLastFetched = 0;
const NEWS_REFRESH_MS = 60 * 60_000;

/** Smart-alerts thresholds. */
const ALERT_EQUITY_DROP_PCT = 0.02; // 2% drop in 1h triggers alert
const ALERT_DL_WARN_RATIO = 0.8; // 80% of daily-loss cap = warning
const ALERT_TL_WARN_RATIO = 0.8; // 80% of total-loss cap = warning
const ALERT_STUCK_DAYS = 15; // challenge stuck >15d = warning
const DAILY_SUMMARY_HOUR_UTC = 22; // 22:00 UTC daily summary

interface AlertsState {
  lastEquitySnapshot: { ts: number; equity: number } | null;
  lastDailySummary: string | null; // YYYY-MM-DD of last daily summary sent
  lastDLWarning: number | null; // ms timestamp of last DL warning
  lastTLWarning: number | null;
  lastStuckWarning: number | null;
}

function loadAlertsState(): AlertsState {
  return readJSON<AlertsState>(ALERTS_STATE_PATH, {
    lastEquitySnapshot: null,
    lastDailySummary: null,
    lastDLWarning: null,
    lastTLWarning: null,
    lastStuckWarning: null,
  });
}
function saveAlertsState(s: AlertsState) {
  writeJSON(ALERTS_STATE_PATH, s);
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readJSON<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch (e) {
    console.error(`[ftmo-live] failed to read ${p}:`, e);
    return fallback;
  }
}

function writeJSON(p: string, obj: unknown) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function appendLog(entry: object) {
  fs.appendFileSync(
    LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
  );
}

/**
 * Default account state — used before executor has reported anything.
 * Safe defaults (0 day, fresh equity) mean we won't unlock delayed BTC/SOL
 * until the executor actually reports gains.
 */
function defaultAccount(): AccountState {
  return {
    equity: 1.0,
    day: 0,
    recentPnls: [],
    equityAtDayStart: 1.0,
  };
}

/** Msec until next TF UTC boundary. 4h: 00/04/08/12/16/20. 2h: every 2h. */
function msUntilNextTfBoundary(): number {
  const now = Date.now();
  const d = new Date(now);
  const h = d.getUTCHours();
  const nextHour = Math.ceil((h + 0.001) / TF_HOURS) * TF_HOURS;
  const next = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      nextHour,
      0,
      30,
      0, // +30s buffer for Binance to close the bar
    ),
  );
  return next.getTime() - now;
}

async function refreshNewsIfStale() {
  if (Date.now() - newsLastFetched < NEWS_REFRESH_MS && cachedNews.length > 0) {
    return;
  }
  try {
    const all = await loadForexFactoryNews();
    // Only high-impact USD/crypto-affecting events for blackout + auto-close.
    cachedNews = filterNewsEvents(all, {
      impacts: ["High"],
      currencies: ["USD"],
    });
    newsLastFetched = Date.now();
    // Write to state dir so Python executor can read for auto-close
    writeJSON(NEWS_PATH, {
      events: cachedNews,
      fetchedAt: new Date().toISOString(),
    });
    console.log(
      `[ftmo-live] news refreshed: ${cachedNews.length} high-impact USD events`,
    );
  } catch (e) {
    console.error(`[ftmo-live] news fetch failed:`, e);
  }
}

async function runOneCheck(): Promise<DetectionResult> {
  console.log(`\n[ftmo-live] ${new Date().toISOString()} — running check`);
  ensureStateDir();

  const eth = await loadBinanceHistory({
    symbol: "ETHUSDT",
    timeframe: TF,
    targetCount: 500,
    maxPages: 2,
  });
  const btc = await loadBinanceHistory({
    symbol: "BTCUSDT",
    timeframe: TF,
    targetCount: 500,
    maxPages: 2,
  });
  const sol = await loadBinanceHistory({
    symbol: "SOLUSDT",
    timeframe: TF,
    targetCount: 500,
    maxPages: 2,
  });

  const account = readJSON<AccountState>(ACCOUNT_PATH, defaultAccount());
  await refreshNewsIfStale();
  const result = detectLiveSignalsV231(eth, btc, sol, account, cachedNews);

  console.log(renderDetection(result));

  // Append new signals to pending queue (dedupe by signalBarClose + asset)
  const pending = readJSON<{ signals: LiveSignal[] }>(PENDING_PATH, {
    signals: [],
  });
  const existingKeys = new Set(
    pending.signals.map((s) => `${s.assetSymbol}@${s.signalBarClose}`),
  );
  const newSignals = result.signals.filter(
    (s) => !existingKeys.has(`${s.assetSymbol}@${s.signalBarClose}`),
  );
  // Check pause flag before queuing
  const controls = readControls(STATE_DIR);
  if (controls.paused && newSignals.length > 0) {
    console.log(
      `[ftmo-live] bot is PAUSED — dropping ${newSignals.length} new signal(s)`,
    );
    await tgSend(
      `⏸ <b>${newSignals.length} signal(s) dropped (bot paused)</b>\n` +
        newSignals
          .map(
            (s) =>
              `${s.assetSymbol} ${s.direction} @ $${s.entryPrice.toFixed(2)}`,
          )
          .join("\n") +
        `\n\nUse /resume to re-enable.`,
    );
    newSignals.length = 0; // don't queue
  }

  if (newSignals.length > 0) {
    pending.signals.push(...newSignals);
    writeJSON(PENDING_PATH, pending);
    console.log(
      `[ftmo-live] queued ${newSignals.length} new signal(s) to ${PENDING_PATH}`,
    );

    // Telegram alert per new signal
    for (const sig of newSignals) {
      const msg = [
        `🚨 <b>NEW SIGNAL</b>`,
        `<b>${sig.assetSymbol}</b> (${sig.sourceSymbol}) — ${sig.direction.toUpperCase()}`,
        `Entry: $${sig.entryPrice.toFixed(4)}`,
        `Stop: $${sig.stopPrice.toFixed(4)} (+${(sig.stopPct * 100).toFixed(2)}%)`,
        `TP: $${sig.tpPrice.toFixed(4)} (−${(sig.tpPct * 100).toFixed(2)}%)`,
        `Risk: ${(sig.riskFrac * 100).toFixed(3)}% · Factor ${sig.sizingFactor.toFixed(2)}×`,
        `Max hold: ${sig.maxHoldHours}h`,
      ].join("\n");
      await tgSend(msg);
    }
  }

  writeJSON(LAST_CHECK_PATH, {
    timestamp: result.timestamp,
    signalCount: result.signals.length,
    skipped: result.skipped.length,
    account,
    btc: result.btc,
  });

  appendLog({
    event: "check",
    signalCount: result.signals.length,
    newSignalsQueued: newSignals.length,
    account,
    signals: result.signals.map((s) => ({
      asset: s.assetSymbol,
      direction: s.direction,
      entry: s.entryPrice,
    })),
    skipped: result.skipped,
  });

  // Smart alerts (equity drop, DL/TL warnings, stuck challenge, daily summary)
  await runSmartAlerts(account);

  return result;
}

/**
 * Smart alerts: equity drop / DL warning / TL warning / stuck challenge / daily summary.
 * Called after each runOneCheck. Stateful via alerts-state.json.
 */
async function runSmartAlerts(account: AccountState) {
  const state = loadAlertsState();
  const now = Date.now();
  const equityPct = (account.equity - 1) * 100;
  const dayStartEquityPct = (account.equityAtDayStart - 1) * 100;
  const dailyPct = equityPct - dayStartEquityPct;

  // 1) Equity-drop alert (>2% drop within 1h)
  if (
    state.lastEquitySnapshot &&
    now - state.lastEquitySnapshot.ts <= 3600_000
  ) {
    const drop = state.lastEquitySnapshot.equity - account.equity;
    if (drop >= ALERT_EQUITY_DROP_PCT) {
      await tgSend(
        `📉 <b>EQUITY DROP ALERT</b>\n` +
          `Equity dropped ${(drop * 100).toFixed(2)}% within 1h\n` +
          `From ${(state.lastEquitySnapshot.equity * 100).toFixed(2)}% → ${(account.equity * 100).toFixed(2)}%\n` +
          `Day ${account.day} of challenge`,
      );
    }
  }
  state.lastEquitySnapshot = { ts: now, equity: account.equity };

  // 2) Daily-loss warning (approaching 5% intraday loss cap)
  if (dailyPct < 0) {
    const dlRatio = Math.abs(dailyPct) / 5; // 5% is the FTMO cap
    if (dlRatio >= ALERT_DL_WARN_RATIO) {
      const lastWarnAge = state.lastDLWarning
        ? now - state.lastDLWarning
        : Infinity;
      if (lastWarnAge > 4 * 3600_000) {
        // throttle: at most 1 alert per 4h
        await tgSend(
          `⚠️ <b>DAILY LOSS WARNING</b>\n` +
            `Daily loss: ${dailyPct.toFixed(2)}% (${(dlRatio * 100).toFixed(0)}% of 5% cap)\n` +
            `Equity: ${(account.equity * 100).toFixed(2)}%\n` +
            `Day ${account.day}`,
        );
        state.lastDLWarning = now;
      }
    }
  }

  // 3) Total-loss warning (approaching 10% drawdown)
  if (equityPct < 0) {
    const tlRatio = Math.abs(equityPct) / 10;
    if (tlRatio >= ALERT_TL_WARN_RATIO) {
      const lastWarnAge = state.lastTLWarning
        ? now - state.lastTLWarning
        : Infinity;
      if (lastWarnAge > 4 * 3600_000) {
        await tgSend(
          `🚨 <b>TOTAL LOSS WARNING</b>\n` +
            `Equity: ${equityPct.toFixed(2)}% (${(tlRatio * 100).toFixed(0)}% of 10% cap)\n` +
            `Bot might pause itself if this continues.\n` +
            `Day ${account.day}`,
        );
        state.lastTLWarning = now;
      }
    }
  }

  // 4) Stuck challenge (>15 days without target hit)
  if (account.day >= ALERT_STUCK_DAYS) {
    const lastWarnAge = state.lastStuckWarning
      ? now - state.lastStuckWarning
      : Infinity;
    if (lastWarnAge > 24 * 3600_000) {
      // at most 1 stuck alert per day
      await tgSend(
        `⏰ <b>STUCK CHALLENGE WARNING</b>\n` +
          `Day ${account.day} reached without passing.\n` +
          `Current equity: ${equityPct.toFixed(2)}% (target +10%)\n` +
          `Backtest p90 = 10d, this is unusual.`,
      );
      state.lastStuckWarning = now;
    }
  }

  // 5) Daily P&L summary at 22:00 UTC
  const today = new Date().toISOString().slice(0, 10);
  const utcHour = new Date().getUTCHours();
  if (utcHour === DAILY_SUMMARY_HOUR_UTC && state.lastDailySummary !== today) {
    const pnlIcon = dailyPct >= 0 ? "🟢" : "🔴";
    await tgSend(
      `${pnlIcon} <b>Daily Summary</b> (${today})\n` +
        `Equity: ${equityPct.toFixed(2)}% (target +10%)\n` +
        `Today's P&L: ${dailyPct >= 0 ? "+" : ""}${dailyPct.toFixed(2)}%\n` +
        `Day ${account.day} of 30 (${30 - account.day} remaining)\n` +
        `Status: ${equityPct >= 10 ? "🏆 PASSED" : equityPct < -10 ? "❌ TOTAL LOSS" : "⏳ Active"}`,
    );
    state.lastDailySummary = today;
  }

  saveAlertsState(state);
}

async function main() {
  console.log("[ftmo-live] FTMO Live Signal Service starting");
  console.log(`[ftmo-live] State directory: ${STATE_DIR}`);
  ensureStateDir();

  await tgSend(
    `🤖 <b>FTMO Signal Service ONLINE (${TF})</b>\nState dir: <code>${htmlEscape(STATE_DIR)}</code>\nNext check at next ${TF} UTC boundary.`,
  );

  // Start Telegram command receiver in background
  startTelegramBot({
    stateDir: STATE_DIR,
    challengeStartBalance: Number(process.env.FTMO_START_BALANCE ?? "100000"),
  }).catch((e) => console.error("[ftmo-live] telegram bot error:", e));

  const oneShot = process.argv.includes("--once");

  if (oneShot) {
    await runOneCheck();
    console.log("[ftmo-live] --once mode, exiting");
    return;
  }

  // Initial check
  try {
    await runOneCheck();
  } catch (e) {
    console.error("[ftmo-live] initial check failed:", e);
    appendLog({ event: "error", phase: "initial", message: String(e) });
  }

  // Schedule at each TF UTC boundary (+30s buffer)
  const loop = async () => {
    const wait = msUntilNextTfBoundary();
    const nextAt = new Date(Date.now() + wait).toISOString();
    console.log(
      `[ftmo-live] next check at ${nextAt} (in ${(wait / 60000).toFixed(1)} min)`,
    );
    setTimeout(async () => {
      try {
        await runOneCheck();
      } catch (e) {
        console.error("[ftmo-live] scheduled check failed:", e);
        appendLog({ event: "error", phase: "scheduled", message: String(e) });
      }
      loop();
    }, wait);
  };
  loop();

  // Keep-alive status ping every minute
  setInterval(() => {
    const status = {
      ts: new Date().toISOString(),
      nextCheckInSec: Math.round(msUntilNextTfBoundary() / 1000),
    };
    writeJSON(path.join(STATE_DIR, "service-status.json"), status);
  }, 60_000);
}

main().catch((e) => {
  console.error("[ftmo-live] fatal:", e);
  process.exit(1);
});
