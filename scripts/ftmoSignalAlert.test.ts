/**
 * FTMO Signal Alert — the live signal checker you run on each 4h bar close.
 *
 * Usage:
 *   node ./node_modules/vitest/vitest.mjs run \
 *        --config vitest.scripts.config.ts \
 *        scripts/ftmoSignalAlert.test.ts --reporter=verbose
 *
 * Crontab example (every 4h at 5 min past the hour, to catch the closed bar):
 *   5 0,4,8,12,16,20 * * * cd /path/to/project && \
 *     node ./node_modules/vitest/vitest.mjs run \
 *          --config vitest.scripts.config.ts \
 *          scripts/ftmoSignalAlert.test.ts > /tmp/ftmo-alert.log 2>&1
 *
 * Optional env vars for push notifications:
 *   TELEGRAM_BOT_TOKEN  — get from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat ID (message @userinfobot)
 *
 * If both set, alerts are pushed to Telegram. Otherwise only logged to stdout
 * and appended to `signal-alerts.log`.
 */
import { describe, it, expect } from "vitest";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadForexFactoryNews,
  filterNewsEvents,
} from "../src/utils/forexFactoryNews";
import { detectLiveSignal, renderAlert } from "../src/utils/ftmoSignalDetector";

const LOG_PATH = "signal-alerts.log";
const STATE_PATH = "signal-alerts.state.json";

interface SignalState {
  lastAlertedBarCloseTime: number;
}

function defaultState(): SignalState {
  return { lastAlertedBarCloseTime: 0 };
}

function loadState(): SignalState {
  if (!existsSync(STATE_PATH)) return defaultState();
  // Round 54 Fix #6: corruption-recovery. SIGTERM during the previous
  // (non-atomic) write could leave a 0-byte / half-written JSON file —
  // log it and start fresh rather than crashing the cron job.
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SignalState;
  } catch (e) {
    console.error(
      `[signal-alert] state file corrupt (${STATE_PATH}); starting fresh:`,
      e,
    );
    return defaultState();
  }
}
// Round 54 Fix #6: atomic write — temp + fsync + rename. SIGTERM during a
// plain writeFileSync could otherwise produce a 0-byte / half-flushed state
// file, breaking the next cron run's dedup. Mirrors writeJSON() in
// ftmoLiveService.ts.
function saveState(s: SignalState) {
  const tmp = `${STATE_PATH}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(s, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, STATE_PATH);
}

async function sendTelegram(msg: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: "HTML",
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

describe("ftmo signal alert", { timeout: 60_000 }, () => {
  it("checks for live signal + optional telegram push", async () => {
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "4h",
      targetCount: 100,
      maxPages: 2,
    });

    let news: Awaited<ReturnType<typeof loadForexFactoryNews>> = [];
    try {
      news = filterNewsEvents(await loadForexFactoryNews(), {
        impacts: ["High"],
        currencies: ["USD", "EUR", "GBP"],
      });
    } catch {
      // FF can rate-limit; proceed without news filter
    }

    const alert = detectLiveSignal(eth, btc, news);
    const rendered = renderAlert(alert);
    console.log(rendered);

    // Log every run
    appendFileSync(LOG_PATH, `\n${"=".repeat(60)}\n${rendered}\n`, "utf8");

    // Telegram push only on NEW signal (not duplicate)
    if (alert.hasSignal) {
      // R67-r4 audit: PID-file lock around the load/sendTG/save sequence so
      // two overlapping cron-runs (slow Binance fetch leaves prev still
      // sending Telegram) don't both push the same alert. The previous code
      // had a 200-2000ms TOCTOU window between loadState and saveState.
      const LOCK_PATH = "signal-alerts.lock";
      const haveLock = (() => {
        try {
          if (existsSync(LOCK_PATH)) {
            const pid = parseInt(readFileSync(LOCK_PATH, "utf8"), 10);
            try {
              process.kill(pid, 0);
              return false; // alive → previous instance still running
            } catch {
              /* stale → fall through and overwrite */
            }
          }
          writeFileSync(LOCK_PATH, String(process.pid));
          return true;
        } catch {
          return true; // best-effort: don't block alerts on lock error
        }
      })();
      if (!haveLock) {
        console.log(
          "\n⏭ Previous signal-alert run still active (lockfile); skipping push",
        );
      } else {
        try {
          const state = loadState();
          if (alert.signalBarClose > state.lastAlertedBarCloseTime) {
            const pushed = await sendTelegram(rendered);
            if (pushed) {
              console.log("\n📲 Pushed to Telegram");
            } else {
              console.log(
                "\n📲 (Telegram not configured; set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env)",
              );
            }
            saveState({ lastAlertedBarCloseTime: alert.signalBarClose });
          } else {
            console.log(
              `\n⏭ Signal for this bar already alerted (${new Date(alert.signalBarClose).toISOString()})`,
            );
          }
        } finally {
          try {
            unlinkSync(LOCK_PATH);
          } catch {
            /* ignore */
          }
        }
      }
    }

    expect(true).toBe(true);
  });
});
