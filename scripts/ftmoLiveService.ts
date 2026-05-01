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
import { detectLiveSignalsV4 } from "../src/utils/ftmoLiveSignalV4Wrapper";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
} from "../src/utils/ftmoDaytrade24h";
import { formatLiveCapsLabel } from "../src/utils/ftmoLiveCaps";
import type { Candle } from "../src/utils/indicators";
import { tgSend, htmlEscape } from "../src/utils/telegramNotify";
import { startTelegramBot, readControls } from "../src/utils/telegramBot";
import {
  loadForexFactoryNews,
  filterNewsEvents,
  type NewsEvent,
} from "../src/utils/forexFactoryNews";

const TF: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" =
  process.env.FTMO_TF === "5m-live"
    ? "5m"
    : process.env.FTMO_TF === "15m" ||
        process.env.FTMO_TF === "15m-live" ||
        process.env.FTMO_TF === "15m-live-v1" ||
        process.env.FTMO_TF === "15m-live-v2"
      ? "15m"
      : process.env.FTMO_TF === "30m" ||
          process.env.FTMO_TF === "30m-live-v1" ||
          process.env.FTMO_TF === "30m-live" ||
          process.env.FTMO_TF === "30m-turbo" ||
          // CRITICAL FIX (Round 12 R72): V5_PLATINUM_30M and all V5_TITANIUM-derived
          // configs (OBSIDIAN/ZIRKON/AMBER/QUARTZ/TOPAZ/RUBIN/SAPPHIR/EMERALD/PEARL/
          // OPAL/AGATE/JADE/ONYX/QUARTZ_STEP2) are tuned on 30m bars even though their
          // FTMO_TF env starts with "2h-trend-". Without this mapping the live bot
          // fed 2h-candles into 30m-tuned configs → wrong signals + wrong PnL.
          [
            "2h-trend-v5-platinum-30m",
            "2h-trend-v5-titanium",
            "2h-trend-v5-obsidian",
            "2h-trend-v5-zirkon",
            "2h-trend-v5-amber",
            "2h-trend-v5-quartz",
            "2h-trend-v5-quartz-lite",
            "2h-trend-v5-quartz-lite-r28",
            "2h-trend-v5-quartz-lite-r28-v2",
            "2h-trend-v5-quartz-lite-r28-v3",
            "2h-trend-v5-quartz-lite-r28-v4",
            "2h-trend-v5-quartz-lite-r28-v4engine",
            // Round 46/47 Breakout champion — deployed via V4-Engine path.
            "2h-trend-breakout-v1",
            "2h-trend-v5-quartz-step2",
            "2h-trend-v5-topaz",
            "2h-trend-v5-rubin",
            "2h-trend-v5-sapphir",
            "2h-trend-v5-emerald",
            "2h-trend-v5-pearl",
            "2h-trend-v5-opal",
            "2h-trend-v5-agate",
            "2h-trend-v5-jade",
            "2h-trend-v5-onyx",
          ].includes(process.env.FTMO_TF ?? "")
        ? "30m"
        : process.env.FTMO_TF === "1h" ||
            process.env.FTMO_TF === "1h-live" ||
            process.env.FTMO_TF === "1h-live-v1"
          ? "1h"
          : process.env.FTMO_TF === "2h" ||
              process.env.FTMO_TF === "2h-live" ||
              process.env.FTMO_TF === "2h-live-v1" ||
              (process.env.FTMO_TF ?? "").startsWith("2h-trend")
            ? "2h"
            : process.env.FTMO_TF === "4h-live" ||
                process.env.FTMO_TF === "4h-live-v1" ||
                process.env.FTMO_TF === "4h-trend"
              ? "4h"
              : "4h";
const TF_HOURS =
  TF === "5m"
    ? 5 / 60
    : TF === "15m"
      ? 0.25
      : TF === "30m"
        ? 0.5
        : TF === "1h"
          ? 1
          : TF === "2h"
            ? 2
            : 4;
// BUGFIX 2026-04-28 (Round 16): per-FTMO_TF state-dir prevents Step 1 / Step 2
// collision (V5 + V5_STEP2 both mapped to TF=2h, same state dir → Step 2 inherited
// Step 1's pause-state → bot stuck in pause).
const STATE_DIR =
  process.env.FTMO_STATE_DIR ??
  path.join(process.cwd(), `ftmo-state-${process.env.FTMO_TF ?? TF}`);
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
const RISK_HEARTBEAT_INTERVAL_MS = 4 * 3600_000; // 4h between risk-stats sends
const RISK_HEARTBEAT_LOOKBACK_MS = 24 * 3600_000; // aggregate over last 24h

/** A signal observed in the rolling 24h window — drives risk heartbeat stats. */
interface RecentSignalSample {
  ts: number;
  asset: string;
  riskFrac: number;
  stopPct: number;
}

interface AlertsState {
  lastEquitySnapshot: { ts: number; equity: number } | null;
  lastDailySummary: string | null; // YYYY-MM-DD of last daily summary sent
  lastDLWarning: number | null; // ms timestamp of last DL warning
  lastTLWarning: number | null;
  lastStuckWarning: number | null;
  lastRiskHeartbeat: number | null; // ms ts of last risk-stats send
  recentSignals: RecentSignalSample[]; // rolling 24h sample log
}

function loadAlertsState(): AlertsState {
  return readJSON<AlertsState>(ALERTS_STATE_PATH, {
    lastEquitySnapshot: null,
    lastDailySummary: null,
    lastDLWarning: null,
    lastTLWarning: null,
    lastStuckWarning: null,
    lastRiskHeartbeat: null,
    recentSignals: [],
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

/**
 * Cross-process advisory lock via O_EXCL — same pattern as Python's
 * `_file_lock` in tools/ftmo_executor.py. Used when read-modify-write of
 * shared state files (pending-signals.json, executed-signals.json) must be
 * atomic across the Node service AND the Python executor.
 *
 * Phase 19 (Live Service Bug 3): without this lock, the R-M-W sequence
 *   Node: read pending → check dedup → write pending+new
 * could be interleaved with the Python executor's
 *   Py: read pending → process & remove → write pending-remaining
 * → Node's write overwrote Python's removal, OR Python's write lost
 * Node's append. Race-window is tiny but real on shared 30s polling.
 */
async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd: number | null = null;
  while (true) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        // Stale lock recovery: if older than 30s, claim it.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 30_000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* lock disappeared — retry */
        }
        throw new Error(`withFileLock: timeout acquiring ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function writeJSON(p: string, obj: unknown) {
  // Atomic write: write to temp file, then rename. Prevents corruption if
  // process is killed mid-write (Python executor reads these files concurrently).
  // Bug-Audit Phase 4 (Live Service Bug 1): mkdir parent first — without this
  // a cold-start before ensureStateDir() crashes with ENOENT (e.g. Telegram
  // supervisor coroutine starts before runOneCheck calls ensureStateDir).
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// BUGFIX 2026-04-28 (Round 12 Bug 3): rotate signal-log.jsonl when it
// grows past 10MB. Keeps last 5 archives (signal-log.jsonl.1..5). Without
// this the file grew unbounded — multi-month deployments hit GB-scale and
// log-tailing tools choked.
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 5;

function rotateLogIfNeeded(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const size = fs.statSync(LOG_PATH).size;
    if (size < LOG_ROTATE_BYTES) return;
    // Shift archives: .4 → .5, .3 → .4, …, .jsonl → .1
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const src = `${LOG_PATH}.${i}`;
      const dst = `${LOG_PATH}.${i + 1}`;
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst);
        } catch {
          /* ignore */
        }
      }
    }
    fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  } catch (e) {
    console.error(`[svc] log rotate failed:`, e);
  }
}

function appendLog(entry: object) {
  // Bug-Audit Phase 4 (Live Service Bug 14): swallow log-write errors.
  // Disk-full / permission errors here would otherwise propagate up to
  // trackedRunOneCheck → consecutiveFailures++ → false-positive
  // "Binance failing" alert + recovery toggle.
  try {
    rotateLogIfNeeded();
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch (e) {
    console.error("[svc] log append failed:", e);
  }
}

/**
 * Default account state — used before executor has reported anything.
 * Safe defaults (0 day, fresh equity) mean we won't unlock delayed BTC/SOL
 * until the executor actually reports gains.
 */
function defaultAccount(): AccountState {
  // Bug-Audit Phase 4 (Live Service Bug 9): when account.json is missing
  // (cold start, state-dir wipe), still try to read Python's
  // challenge-peak.json to preserve peakDrawdownThrottle correctness for
  // R28_V2/V3/V4. Otherwise we'd silently fall to challengePeak=1.0
  // → V231 sees no drawdown → no throttle → live drifts back to R28 baseline.
  const peakFile = path.join(STATE_DIR, "challenge-peak.json");
  let challengePeak = 1.0;
  try {
    if (fs.existsSync(peakFile)) {
      const raw = JSON.parse(fs.readFileSync(peakFile, "utf8"));
      // Python writes either {peak: <frac>} (Round 36 helper) or
      // {peak_equity_usd: <usd>, ...} (Round 35). Try both shapes.
      if (typeof raw?.peak === "number" && raw.peak > 0) {
        challengePeak = raw.peak;
      } else if (
        typeof raw?.peak_equity_usd === "number" &&
        raw.peak_equity_usd > 0
      ) {
        const startBal = Number(process.env.FTMO_START_BALANCE ?? "100000");
        if (startBal > 0) challengePeak = raw.peak_equity_usd / startBal;
      }
    }
  } catch (e) {
    console.error("[svc] failed to read challenge-peak.json fallback:", e);
  }
  return {
    equity: 1.0,
    day: 0,
    recentPnls: [],
    equityAtDayStart: 1.0,
    challengePeak,
  };
}

/** Msec until next TF UTC boundary. 30m: HH:00/HH:30. 1h: HH:00. 2h/4h: standard. */
function msUntilNextTfBoundary(): number {
  const now = Date.now();
  const d = new Date(now);
  if (TF_HOURS < 1) {
    // 30m: snap to next half-hour boundary in minutes
    const stepMin = Math.round(TF_HOURS * 60); // 30
    const totalMin =
      d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
    const nextMin = Math.ceil((totalMin + 0.001) / stepMin) * stepMin;
    const next = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        Math.floor(nextMin / 60),
        nextMin % 60,
        30,
        0,
      ),
    );
    return next.getTime() - now;
  }
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
      0,
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
    // BUGFIX 2026-04-28 (Round 10): retry-storm prevention. On failure, set
    // cooldown so we don't hammer the API every check. Also fall back to
    // last persisted news file if available so news-blackout still works.
    newsLastFetched = Date.now() - NEWS_REFRESH_MS + 5 * 60_000; // retry in 5min
    if (cachedNews.length === 0) {
      try {
        const persisted = readJSON<{ events: NewsEvent[] }>(NEWS_PATH, {
          events: [],
        });
        if (persisted.events.length > 0) {
          cachedNews = persisted.events;
          console.log(
            `[ftmo-live] news fetch failed — using persisted ${cachedNews.length} events as fallback`,
          );
        }
      } catch {}
    }
  }
}

async function runOneCheck(): Promise<DetectionResult> {
  console.log(`\n[ftmo-live] ${new Date().toISOString()} — running check`);
  ensureStateDir();

  // BUGFIX 2026-04-28 (Round 36 Bug 6): parallel + per-symbol fault-tolerant.
  // Was 8 sequential awaits — single 503 mid-cycle aborted the whole tick.
  // Now ETH+BTC are required (throw if missing); all others best-effort.
  const fetchOne = (
    sym: string,
  ): Promise<import("../src/utils/indicators").Candle[]> =>
    loadBinanceHistory({
      symbol: sym,
      timeframe: TF,
      targetCount: 500,
      maxPages: 2,
    });

  // BUGFIX 2026-04-28: extended default symbol list to cover V5_NOVA (8 assets),
  // V5_TITAN_REAL, V5_LEGEND, and V5 baseline. Previously only 5 extras → some
  // configs silently degraded to fewer assets when env not set.
  // V5_NOVA needs: ETH, BTC, BNB, ADA, DOGE, LTC, BCH, LINK.
  // V5 baseline: ETH, BTC, SOL, BNB, ADA, AVAX, LTC, BCH, LINK + DOGE.
  // Phase 13 (Strategy Configs Bug 1): default extras now cover ALL active
  // V5-family baskets. R28 needs {ETC, XRP, AAVE}, V5_QUARTZ adds {INJ,
  // RUNE, SAND}, V5_OBSIDIAN+ adds ARB. Without these the live bot silently
  // loaded only 6/9 (or 9/15) configured assets → wrong strategy.
  // Override with FTMO_EXTRA_SYMBOLS=... to narrow.
  const extraSymbols = process.env.FTMO_EXTRA_SYMBOLS
    ? process.env.FTMO_EXTRA_SYMBOLS.split(",")
    : [
        "BNBUSDT",
        "ADAUSDT",
        "AVAXUSDT",
        "BCHUSDT",
        "DOGEUSDT",
        "LTCUSDT",
        "LINKUSDT",
        // R28 9-asset basket additions:
        "ETCUSDT",
        "XRPUSDT",
        "AAVEUSDT",
        // V5_QUARTZ / V5_OBSIDIAN superset:
        "INJUSDT",
        "RUNEUSDT",
        "SANDUSDT",
        "ARBUSDT",
      ];

  const allSymbols = ["ETHUSDT", "BTCUSDT", "SOLUSDT", ...extraSymbols];
  const settled = await Promise.allSettled(allSymbols.map(fetchOne));
  const candleMap: Record<string, import("../src/utils/indicators").Candle[]> =
    {};
  for (let i = 0; i < allSymbols.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      candleMap[allSymbols[i]] = r.value;
    } else {
      console.error(
        `[ftmo-live] symbol ${allSymbols[i]} load failed:`,
        r.reason,
      );
    }
  }
  const eth = candleMap["ETHUSDT"];
  const btc = candleMap["BTCUSDT"];
  if (!eth || !btc) {
    throw new Error(
      `Binance fetch failed for required symbols: eth=${!!eth} btc=${!!btc}`,
    );
  }
  const sol = candleMap["SOLUSDT"] ?? [];
  const extraCandles: Record<
    string,
    import("../src/utils/indicators").Candle[]
  > = {};
  for (const sym of extraSymbols) {
    if (candleMap[sym]) extraCandles[sym] = candleMap[sym];
  }

  const account = readJSON<AccountState>(ACCOUNT_PATH, defaultAccount());
  await refreshNewsIfStale();
  // V4-Engine path: persistent-state live engine (Round 40).
  // Selector convention: FTMO_TF ends with "-v4engine" OR is "2h-trend-breakout-v1"
  // (Breakout always runs on V4-Engine because polling V231 doesn't know breakoutEntry).
  const isBreakoutV1 = process.env.FTMO_TF === "2h-trend-breakout-v1";
  const useV4Engine =
    (process.env.FTMO_TF ?? "").endsWith("-v4engine") || isBreakoutV1;
  let result: DetectionResult;
  if (useV4Engine) {
    // For now two cfgs supported via v4engine — extend mapping here
    // as more configs are validated under V4 persistent-state semantics.
    const v4Cfg = isBreakoutV1
      ? FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1
      : FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4;
    const v4Label = isBreakoutV1 ? "BREAKOUT_V1" : "V5_QUARTZ_LITE_R28_V4";
    const fullCandleMap: Record<
      string,
      import("../src/utils/indicators").Candle[]
    > = {
      ETHUSDT: eth,
      BTCUSDT: btc,
      SOLUSDT: sol,
      ...extraCandles,
    };
    result = detectLiveSignalsV4(
      fullCandleMap,
      v4Cfg,
      v4Label,
      STATE_DIR,
      account,
    );
  } else {
    result = detectLiveSignalsV231(
      eth,
      btc,
      sol,
      account,
      cachedNews,
      extraCandles,
    );
  }

  console.log(renderDetection(result));

  // Phase 19 (Live Service Bug 3): cross-process R-M-W on pending-signals.json
  // wrapped in file-lock. Python executor uses _file_lock for the same path —
  // both processes now serialize on the same lock file (O_EXCL semantics).
  const PENDING_LOCK = path.join(STATE_DIR, "pending-signals.lock");
  await withFileLock(PENDING_LOCK, async () => {
    // Append new signals to pending queue.
    // Dedup against BOTH pending AND executed signals — otherwise a service
    // restart between signal queue and executor pickup could re-queue the
    // same setup → 2x risk on a single bar.
    const pending = readJSON<{ signals: LiveSignal[] }>(PENDING_PATH, {
      signals: [],
    });
    // Python executor schema: { executions: [{ signal: {...}, result, ts }] }
    // Older/forward-compat schema: { signals: [{ assetSymbol, signalBarClose }] }
    // Read both shapes so dedup works regardless of who wrote the file.
    const executed = readJSON<{
      executions?: Array<{
        signal?: { assetSymbol?: string; signalBarClose?: number };
      }>;
      signals?: Array<{
        signalAsset?: string;
        assetSymbol?: string;
        signalBarClose?: number;
      }>;
    }>(EXECUTED_PATH, { executions: [] });
    const executedKeys: string[] = [];
    for (const e of executed.executions ?? []) {
      if (e.signal && e.signal.signalBarClose !== undefined) {
        executedKeys.push(`${e.signal.assetSymbol}@${e.signal.signalBarClose}`);
      }
    }
    for (const s of executed.signals ?? []) {
      if (s.signalBarClose !== undefined) {
        executedKeys.push(
          `${s.signalAsset ?? s.assetSymbol}@${s.signalBarClose}`,
        );
      }
    }
    const existingKeys = new Set([
      ...pending.signals.map((s) => `${s.assetSymbol}@${s.signalBarClose}`),
      ...executedKeys,
    ]);
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

    // Sample emitted signals into rolling 24h log for the risk heartbeat.
    if (result.signals.length > 0) {
      recordRecentSignals(result.signals);
    }

    // Smart alerts (equity drop, DL/TL warnings, stuck challenge, daily summary, risk heartbeat)
    await runSmartAlerts(account);
  }); // close withFileLock(PENDING_LOCK, ...)

  return result;
}

function recordRecentSignals(signals: LiveSignal[]) {
  const state = loadAlertsState();
  const now = Date.now();
  const cutoff = now - RISK_HEARTBEAT_LOOKBACK_MS;
  const kept = (state.recentSignals ?? []).filter((s) => s.ts >= cutoff);
  for (const sig of signals) {
    kept.push({
      ts: now,
      asset: sig.assetSymbol,
      riskFrac: sig.riskFrac,
      stopPct: sig.stopPct,
    });
  }
  state.recentSignals = kept;
  saveAlertsState(state);
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

  // 4b) Risk-stats heartbeat — every 4h, summarise riskFrac/stopPct of
  // signals emitted in the last 24h. Catches a regression like the
  // historical 200%-riskFrac bug at the soonest 4h window.
  const lastHb = state.lastRiskHeartbeat ?? 0;
  if (now - lastHb >= RISK_HEARTBEAT_INTERVAL_MS) {
    const cutoff = now - RISK_HEARTBEAT_LOOKBACK_MS;
    const samples = (state.recentSignals ?? []).filter((s) => s.ts >= cutoff);
    if (samples.length > 0) {
      const riskMax = Math.max(...samples.map((s) => s.riskFrac));
      const riskAvg =
        samples.reduce((a, s) => a + s.riskFrac, 0) / samples.length;
      const stopMax = Math.max(...samples.map((s) => s.stopPct));
      const stopAvg =
        samples.reduce((a, s) => a + s.stopPct, 0) / samples.length;
      const assets = [...new Set(samples.map((s) => s.asset))];
      const flag = riskMax > 0.05 || stopMax > 0.05 ? "🚨 OUT-OF-BAND " : "📊 ";
      await tgSend(
        `${flag}<b>Risk Heartbeat (24h)</b>\n` +
          `Signals: ${samples.length} (${assets.join(", ")})\n` +
          `Risk:  avg ${(riskAvg * 100).toFixed(2)}% · max ${(riskMax * 100).toFixed(2)}%\n` +
          `Stop:  avg ${(stopAvg * 100).toFixed(2)}% · max ${(stopMax * 100).toFixed(2)}%\n` +
          `Live caps: ${formatLiveCapsLabel()}`,
      );
    }
    state.lastRiskHeartbeat = now;
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

  // BUGFIX 2026-04-28 (Round 10 Bug 5): supervisor restarts the bot if its
  // poll loop crashes. Without this an unhandled rejection in startTelegramBot
  // (e.g. unparseable response, transient network failure) silently killed
  // the command receiver while the rest of the service kept running.
  const telegramSupervisor = async () => {
    let restarts = 0;
    while (true) {
      try {
        await startTelegramBot({
          stateDir: STATE_DIR,
          challengeStartBalance: Number(
            process.env.FTMO_START_BALANCE ?? "100000",
          ),
        });
        // Normal exit (e.g. config missing) — don't restart.
        return;
      } catch (e) {
        restarts++;
        console.error(`[ftmo-live] telegram bot crashed (#${restarts}):`, e);
        // Exp backoff capped at 5 min.
        const backoff = Math.min(5 * 60_000, 5_000 * Math.pow(2, restarts - 1));
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  };
  telegramSupervisor().catch((e) =>
    console.error("[ftmo-live] telegram supervisor fatal:", e),
  );

  const oneShot = process.argv.includes("--once");

  if (oneShot) {
    await runOneCheck();
    console.log("[ftmo-live] --once mode, exiting");
    return;
  }

  // BUGFIX 2026-04-28 (Round 10 Bug 9): track consecutive Binance failures
  // and alert via Telegram if they persist. Without this the service
  // silently spins on a permanent network outage / rate limit.
  let consecutiveFailures = 0;
  let lastFailureAlert = 0;
  const FAILURE_ALERT_THRESHOLD = 3; // first alert after 3 in a row
  const FAILURE_ALERT_INTERVAL_MS = 60 * 60 * 1000; // re-alert hourly

  const trackedRunOneCheck = async (phase: string) => {
    try {
      await runOneCheck();
      if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
        // Recovery: send "back online" once.
        await tgSend(
          `✅ <b>Binance check recovered</b> (after ${consecutiveFailures} consecutive failures)`,
        ).catch(() => {});
      }
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      console.error(
        `[ftmo-live] ${phase} check failed (${consecutiveFailures} in a row):`,
        e,
      );
      appendLog({
        event: "error",
        phase,
        message: String(e),
        consecutiveFailures,
      });
      const now = Date.now();
      const shouldAlert =
        consecutiveFailures >= FAILURE_ALERT_THRESHOLD &&
        now - lastFailureAlert > FAILURE_ALERT_INTERVAL_MS;
      if (shouldAlert) {
        lastFailureAlert = now;
        await tgSend(
          `🔴 <b>Binance check failing</b>\n` +
            `${consecutiveFailures} consecutive failures.\n` +
            `Last error: <code>${htmlEscape(String(e).slice(0, 200))}</code>\n` +
            `Service will keep retrying at every TF boundary.`,
        ).catch(() => {});
      }
    }
  };

  // Initial check
  await trackedRunOneCheck("initial");

  // Schedule at each TF UTC boundary (+30s buffer)
  const loop = async () => {
    const wait = msUntilNextTfBoundary();
    const nextAt = new Date(Date.now() + wait).toISOString();
    console.log(
      `[ftmo-live] next check at ${nextAt} (in ${(wait / 60000).toFixed(1)} min)`,
    );
    setTimeout(async () => {
      await trackedRunOneCheck("scheduled");
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
