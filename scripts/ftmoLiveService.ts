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
  getActiveCfgInfo,
  getActiveCfg,
  type AccountState,
  type DetectionResult,
  type LiveSignal,
} from "../src/utils/ftmoLiveSignalV231";
import { detectLiveSignalsV4 } from "../src/utils/ftmoLiveSignalV4Wrapper";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6,
  FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1,
} from "../src/utils/ftmoDaytrade24h";
import { formatLiveCapsLabel } from "../src/utils/ftmoLiveCaps";
import type { Candle } from "../src/utils/indicators";
import { tgSend, htmlEscape } from "../src/utils/telegramNotify";
import { startTelegramBot, readControls } from "../src/utils/telegramBot";
import { withFileLock } from "../src/utils/processLock";
import { acquireSingletonLock } from "../src/utils/serviceSingleton";
import {
  loadForexFactoryNews,
  filterNewsEvents,
  type NewsEvent,
} from "../src/utils/forexFactoryNews";

// Phase 27 (Live Service Bug 12): TF-mapping refactored to a dispatch table.
// Was a 60-line nested ternary that required adding new selectors to BOTH
// the cascade AND `useV4Engine` — typos / forgotten entries silently routed
// into the 4h-default fallback (R72-class bug). Single source of truth now.
//
// Format: env-string → polled-bar TF.
// Configs that aren't here fall back via the `2h-trend` prefix rule below
// (which routes to "2h"); add here explicitly when polling cadence differs.
type TfTag = "5m" | "15m" | "30m" | "1h" | "2h" | "4h";

const TF_DISPATCH: Record<string, TfTag> = {
  // 5m
  "5m-live": "5m",
  // 15m
  "15m": "15m",
  "15m-live": "15m",
  "15m-live-v1": "15m",
  "15m-live-v2": "15m",
  // 30m direct
  "30m": "30m",
  "30m-live": "30m",
  "30m-live-v1": "30m",
  "30m-turbo": "30m",
  // 30m-tuned configs that wear a "2h-trend-" badge — DO NOT REMOVE without
  // verifying the underlying CFG.timeframe! (Round 12 R72)
  "2h-trend-v5-platinum-30m": "30m",
  "2h-trend-v5-titanium": "30m",
  "2h-trend-v5-obsidian": "30m",
  "2h-trend-v5-zirkon": "30m",
  "2h-trend-v5-amber": "30m",
  "2h-trend-v5-quartz": "30m",
  "2h-trend-v5-quartz-lite": "30m",
  "2h-trend-v5-quartz-lite-r28": "30m",
  "2h-trend-v5-quartz-lite-r28-v2": "30m",
  "2h-trend-v5-quartz-lite-r28-v3": "30m",
  "2h-trend-v5-quartz-lite-r28-v4": "30m",
  "2h-trend-v5-quartz-lite-r28-v4engine": "30m",
  "2h-trend-v5-quartz-lite-r28-v5": "30m",
  "2h-trend-v5-quartz-lite-r28-v5-v4engine": "30m",
  "2h-trend-v5-quartz-lite-r28-v6": "30m",
  "2h-trend-v5-quartz-lite-r28-v6-v4engine": "30m",
  "2h-trend-breakout-v1": "30m",
  "2h-trend-v5-quartz-step2": "30m",
  "2h-trend-v5-topaz": "30m",
  "2h-trend-v5-rubin": "30m",
  "2h-trend-v5-sapphir": "30m",
  "2h-trend-v5-emerald": "30m",
  "2h-trend-v5-pearl": "30m",
  "2h-trend-v5-opal": "30m",
  "2h-trend-v5-agate": "30m",
  "2h-trend-v5-jade": "30m",
  "2h-trend-v5-onyx": "30m",
  // 1h
  "1h": "1h",
  "1h-live": "1h",
  "1h-live-v1": "1h",
  // 2h
  "2h": "2h",
  "2h-live": "2h",
  "2h-live-v1": "2h",
  // 4h
  "4h-live": "4h",
  "4h-live-v1": "4h",
  "4h-trend": "4h",
};

function resolveTf(envValue: string | undefined): TfTag {
  if (envValue && TF_DISPATCH[envValue]) return TF_DISPATCH[envValue];
  // Fall-through rule: any other "2h-trend-*" gets 2h (legacy V231 family).
  if (envValue?.startsWith("2h-trend")) return "2h";
  return "4h"; // ultimate default
}

const TF: TfTag = resolveTf(process.env.FTMO_TF);
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
// Phase 73 (R44-V4-Bug 1): per-account state-dir isolation. Without
// FTMO_ACCOUNT_ID two bots running the same TF + strategy on different
// FTMO accounts would share state files (peak / pause / kelly window /
// open positions) — phantom-position cross-pollination.
//
// FTMO_STATE_DIR (explicit) wins, then ftmo-state-${TF}-${ACCOUNT_ID},
// then the legacy ftmo-state-${TF} fallback (single-account installs
// keep working unchanged).
const FTMO_ACCOUNT_ID = process.env.FTMO_ACCOUNT_ID;
const STATE_DIR =
  process.env.FTMO_STATE_DIR ??
  (FTMO_ACCOUNT_ID
    ? path.join(
        process.cwd(),
        `ftmo-state-${process.env.FTMO_TF ?? TF}-${FTMO_ACCOUNT_ID}`,
      )
    : path.join(process.cwd(), `ftmo-state-${process.env.FTMO_TF ?? TF}`));
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
let newsLastSuccessfulFetch = 0;
const NEWS_REFRESH_MS = 60 * 60_000;
// Phase 25 (Live Service Bug 10): if news cache is older than this, treat
// as stale and clear it (don't apply blackout against weeks-old events).
const NEWS_MAX_AGE_MS = 24 * 3600_000;

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
  // Phase 25 (Live Service Bug 15): mkdirSync(recursive: true) is idempotent
  // — drop the existsSync TOCTOU race + handle EEXIST that PM2 cluster-mode
  // could otherwise crash on.
  fs.mkdirSync(STATE_DIR, { recursive: true });
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

// Phase 19/34 (cross-process lock): see src/utils/processLock.ts. Same
// sentinel convention as Python `process_lock.file_lock` so the Node
// service AND the Python executor mutex on shared state files
// (pending-signals.json, executed-signals.json).

function writeJSON(p: string, obj: unknown) {
  // Atomic write: write to temp file, then rename. Prevents corruption if
  // process is killed mid-write (Python executor reads these files concurrently).
  // Bug-Audit Phase 4 (Live Service Bug 1): mkdir parent first — without this
  // a cold-start before ensureStateDir() crashes with ENOENT (e.g. Telegram
  // supervisor coroutine starts before runOneCheck calls ensureStateDir).
  // Phase 25 (Live Service Bug 2): fsync before rename so power-loss /
  // OS-cache flush doesn't leave a 0-byte file at the destination.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

// BUGFIX 2026-04-28 (Round 12 Bug 3): rotate signal-log.jsonl when it
// grows past 10MB. Keeps last 5 archives (signal-log.jsonl.1..5). Without
// this the file grew unbounded — multi-month deployments hit GB-scale and
// log-tailing tools choked.
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const LOG_KEEP = 5;

// Phase 26 (Live Service Bug 4): O_EXCL lock around the rotate critical
// section so two concurrent appendLog callers can't half-rotate. Best-effort
// — if lock can't be acquired in 200ms, skip rotation this tick.
//
// Round 54 Fix #1: token-based unlink to mirror processLock.ts. Without
// a token, a stale-claim from another process would cause us to unlink
// THEIR fresh lock on our way out. We now write `pid:rand` and verify
// before unlink — mismatch = our lock was stolen, leave it alone.
function makeRotateToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function tryAcquireRotateLock(): { fd: number; token: string } | null {
  const lockPath = `${LOG_PATH}.rotate.lock`;
  const token = makeRotateToken();
  const start = Date.now();
  while (Date.now() - start < 200) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, token);
      return { fd, token };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return null;
      // Stale lock recovery — older than 5s, take it.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function releaseRotateLock(token: string): void {
  const lockPath = `${LOG_PATH}.rotate.lock`;
  try {
    const held = fs.readFileSync(lockPath, "utf-8");
    if (held === token) {
      fs.unlinkSync(lockPath);
    }
    // else: another process force-claimed our lock — leave their token alone.
  } catch {
    /* lock-file already gone — nothing to release */
  }
}

/**
 * Round 54 Fix #1: append+rotate combined under a single lock so writes
 * cannot straddle the rename. Concurrent appenders that already had the
 * old inode opened via appendFileSync would otherwise silently write to
 * the rotated `.1` file. Now: hold the rotate lock, decide rename-or-not,
 * THEN append — every write goes to either the pre-rotate or post-rotate
 * inode, never both.
 */
function appendAndRotate(line: string): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  let needRotate = false;
  try {
    if (fs.existsSync(LOG_PATH)) {
      needRotate = fs.statSync(LOG_PATH).size >= LOG_ROTATE_BYTES;
    }
  } catch {
    /* stat failed — proceed without rotate */
  }
  if (!needRotate) {
    fs.appendFileSync(LOG_PATH, line);
    return;
  }
  const lock = tryAcquireRotateLock();
  if (lock === null) {
    // Couldn't get lock — another process is rotating. Append anyway; worst
    // case our line lands in the rotated archive (still preserved).
    fs.appendFileSync(LOG_PATH, line);
    return;
  }
  try {
    // Re-check size under lock — another rotator may have just finished.
    let sizeOk = false;
    try {
      sizeOk =
        fs.existsSync(LOG_PATH) &&
        fs.statSync(LOG_PATH).size >= LOG_ROTATE_BYTES;
    } catch {
      /* ignore */
    }
    if (sizeOk) {
      // Phase 26 (Live Service Bug 5): clean up pre-existing archives beyond
      // LOG_KEEP. If LOG_KEEP was lowered from 10→5 in a redeploy, the old
      // .6..10 files would otherwise leak forever.
      for (let i = LOG_KEEP; i <= 20; i++) {
        try {
          fs.unlinkSync(`${LOG_PATH}.${i}`);
        } catch {
          /* not present — ok */
        }
      }
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
      try {
        fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
      } catch {
        /* race: another rotator beat us — fall through and append */
      }
    }
    // Append AFTER the rename decision under the lock. All writes either
    // hit the pre-rotate inode (we didn't rotate) or the fresh post-rotate
    // file (we did rotate) — never straddle.
    fs.appendFileSync(LOG_PATH, line);
  } finally {
    fs.closeSync(lock.fd);
    releaseRotateLock(lock.token);
  }
}

function appendLog(entry: object) {
  // Bug-Audit Phase 4 (Live Service Bug 14): swallow log-write errors.
  // Disk-full / permission errors here would otherwise propagate up to
  // trackedRunOneCheck → consecutiveFailures++ → false-positive
  // "Binance failing" alert + recovery toggle.
  try {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendAndRotate(line);
  } catch (e) {
    console.error("[svc] log append failed:", e);
  }
}

/**
 * Default account state — used before executor has reported anything.
 * Safe defaults (0 day, fresh equity) mean we won't unlock delayed BTC/SOL
 * until the executor actually reports gains.
 */
/** Read Python's challenge-peak.json, return undefined if missing/invalid. */
function readChallengePeakFromDisk(): number | undefined {
  const peakFile = path.join(STATE_DIR, "challenge-peak.json");
  try {
    if (!fs.existsSync(peakFile)) return undefined;
    const raw = JSON.parse(fs.readFileSync(peakFile, "utf8"));
    if (typeof raw?.peak === "number" && raw.peak > 0) {
      return raw.peak;
    }
    if (typeof raw?.peak_equity_usd === "number" && raw.peak_equity_usd > 0) {
      const startBal = Number(process.env.FTMO_START_BALANCE ?? "100000");
      if (startBal > 0) return raw.peak_equity_usd / startBal;
    }
    return undefined;
  } catch (e) {
    console.error("[svc] failed to read challenge-peak.json:", e);
    return undefined;
  }
}

function defaultAccount(): AccountState {
  // Phase 33 (Audit Bug 11): on cold-start, return undefined challengePeak
  // when challenge-peak.json is missing — so the runOneCheck merge fires.
  // Previously returned 1.0 default → merge skipt because !== undefined.
  const onDisk = readChallengePeakFromDisk();
  return {
    equity: 1.0,
    day: 0,
    recentPnls: [],
    equityAtDayStart: 1.0,
    challengePeak: onDisk ?? undefined,
  } as AccountState;
}

/** Msec until next TF UTC boundary. 30m: HH:00/HH:30. 1h: HH:00. 2h/4h: standard. */
// Phase 27 (Live Service Bug 8): boundary buffer scales with TF cadence.
// Was hardcoded 30s — on 5m TF that's ~10% of the bar duration wasted on
// every tick. Clamp to [5s, 30s] depending on TF.
const BOUNDARY_BUFFER_SEC = Math.max(
  5,
  Math.min(30, Math.round(TF_HOURS * 60 * 5)),
);
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
        BOUNDARY_BUFFER_SEC,
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
      BOUNDARY_BUFFER_SEC,
      0,
    ),
  );
  return next.getTime() - now;
}

async function refreshNewsIfStale() {
  // Phase 25 (Live Service Bug 10): if last successful fetch is older than
  // NEWS_MAX_AGE_MS, clear cachedNews so blackout doesn't apply against
  // possibly-completed events. Better to skip news-filter than to act on
  // weeks-old data when ForexFactory is down for an extended period.
  if (
    newsLastSuccessfulFetch > 0 &&
    Date.now() - newsLastSuccessfulFetch > NEWS_MAX_AGE_MS &&
    cachedNews.length > 0
  ) {
    console.warn(
      "[ftmo-live] news cache >24h old — clearing (ForexFactory unreachable)",
    );
    cachedNews = [];
  }
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
    newsLastSuccessfulFetch = Date.now();
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
        // R10 audit fix: only trust persisted file if fresh (< NEWS_MAX_AGE_MS).
        // Stale fallback would silently blackout against last-week's events.
        const persisted = readJSON<{
          events: NewsEvent[];
          fetchedAt?: string;
        }>(NEWS_PATH, { events: [] });
        const fetchedAtMs = persisted.fetchedAt
          ? Date.parse(persisted.fetchedAt)
          : NaN;
        const fresh =
          Number.isFinite(fetchedAtMs) &&
          Date.now() - fetchedAtMs < NEWS_MAX_AGE_MS;
        if (persisted.events.length > 0 && fresh) {
          cachedNews = persisted.events;
          console.log(
            `[ftmo-live] news fetch failed — using persisted ${cachedNews.length} events as fallback`,
          );
        } else if (persisted.events.length > 0 && !fresh) {
          console.warn(
            `[ftmo-live] persisted news stale (fetchedAt=${persisted.fetchedAt ?? "missing"}) — discarding fallback`,
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
  // RUNE, SAND}, V5_OBSIDIAN+ adds ARB.
  // Phase 37 (R44-CFG-2): also include {DOT, TRX, ALGO, NEAR, ATOM, STX}
  // for V5_SAPPHIR/EMERALD/PEARL/OPAL/AGATE/JADE basket — without these
  // the live bot silently loaded 14/20 assets when running these tags.
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
        // V5_SAPPHIR..V5_JADE 18-20 asset basket:
        "DOTUSDT",
        "TRXUSDT",
        "ALGOUSDT",
        "NEARUSDT",
        "ATOMUSDT",
        "STXUSDT",
      ];

  // Phase 85 (R51-LIVE-1): de-dupe so a user-supplied FTMO_EXTRA_SYMBOLS
  // overlap doesn't fetch the same symbol twice in parallel — the second
  // result silently overwrote the first when both were `fulfilled`,
  // potentially replacing a complete history with a partial retry.
  const allSymbols = [
    ...new Set(["ETHUSDT", "BTCUSDT", "SOLUSDT", ...extraSymbols]),
  ];
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

  // Round 54 Fix #4: read account.json + challenge-peak.json under a shared
  // peek lock so Python's update_challenge_peak() (which writes peak then
  // account independently) can't slip a stale-peak/fresh-equity pair past us.
  // Short timeout + short stale-recovery window: we'd rather take a slightly
  // racy read than block the polling loop indefinitely if Python doesn't
  // honor the lock.
  const ACCOUNT_LOCK = path.join(STATE_DIR, "account.lock");
  const account = await withFileLock(
    ACCOUNT_LOCK,
    async () => {
      const acc = readJSON<AccountState>(ACCOUNT_PATH, defaultAccount());
      // Phase 30: ALWAYS merge challenge-peak.json into account, not just on
      // cold-start. Python writes account.json without `challengePeak` field,
      // and V231's peakDrawdownThrottle would otherwise emit console.error
      // every poll for the entire process lifetime.
      if (acc.challengePeak === undefined) {
        const onDisk = readChallengePeakFromDisk();
        if (onDisk !== undefined) acc.challengePeak = onDisk;
      }
      return acc;
    },
    { timeoutMs: 1500, staleMs: 2000 },
  );
  await refreshNewsIfStale();
  // V4-Engine path: persistent-state live engine (Round 40).
  // Selector convention: FTMO_TF ends with "-v4engine" OR is "2h-trend-breakout-v1"
  // (Breakout always runs on V4-Engine because polling V231 doesn't know breakoutEntry).
  //
  // Round 60 audit (2026-05-05): the 13 R28_V6 sister selectors (passlock,
  // corrcap2, lscool48, todcutoff18, voltp-aggr, idlt30, combo-pl-idlt,
  // 3× passlock-dayrisk*) DO NOT end in "-v4engine" but their configs carry
  // V4-engine-only flags (closeAllOnTargetReached, volAdaptiveTpMult,
  // dayBasedRiskMultiplier). Without this branch, V231 was silently routing
  // them through the legacy signal-generator → engine flags ignored, defeating
  // the whole Round 60 hunt. Force V4-Engine for every selector matching the
  // R28_V6 sister convention `r28-v6-{feature}`.
  const ftmoTf = process.env.FTMO_TF ?? "";
  const isBreakoutV1 = ftmoTf === "2h-trend-breakout-v1";
  const isR28V5 = ftmoTf === "2h-trend-v5-quartz-lite-r28-v5-v4engine";
  const isR28V6 = ftmoTf === "2h-trend-v5-quartz-lite-r28-v6-v4engine";
  // R60 sister selectors: 2h-trend-v5-r28-v6-{passlock,corrcap2,lscool48,
  // todcutoff18,voltp-aggr,idlt30,combo-pl-idlt,passlock-dayrisk*,…}
  const isR28V6Sister = /^2h-trend-v5-r28-v6-[a-z0-9-]+$/.test(ftmoTf);
  // R10 audit fix: any LSC-using config must route through V4 engine — the
  // legacy V231 path does NOT honor lossStreakCooldown. Catches misnamed selectors.
  const useV4Engine =
    ftmoTf.endsWith("-v4engine") ||
    isBreakoutV1 ||
    isR28V6Sister ||
    !!getActiveCfg().lossStreakCooldown;
  let result: DetectionResult;
  if (useV4Engine) {
    // R60 sister: pick CFG via V231 CFG_REGISTRY lookup (one source of truth).
    let v4Cfg: typeof FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
    let v4Label: string;
    if (isR28V6Sister) {
      const sisterCfg = getActiveCfg();
      v4Cfg =
        sisterCfg as typeof FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6;
      v4Label = `R28_V6_${ftmoTf.replace("2h-trend-v5-r28-v6-", "").toUpperCase()}`;
    } else {
      v4Cfg = isBreakoutV1
        ? (FTMO_DAYTRADE_24H_CONFIG_BREAKOUT_V1 as typeof FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6)
        : isR28V6
          ? FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6
          : isR28V5
            ? (FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V5 as typeof FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6)
            : (FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V4 as typeof FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V6);
      v4Label = isBreakoutV1
        ? "BREAKOUT_V1"
        : isR28V6
          ? "V5_QUARTZ_LITE_R28_V6"
          : isR28V5
            ? "V5_QUARTZ_LITE_R28_V5"
            : "V5_QUARTZ_LITE_R28_V4";
    }
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
  //
  // Round 54 Fix #2: ALL Telegram/network calls happen AFTER lock release.
  // Telegram 429 / network hang of 6+ s would otherwise block Python's
  // read-modify-write on pending-signals.json for seconds → stale-claim.
  // Inside-lock ONLY: disk read-modify-write. Outside-lock: Telegram fire.
  const PENDING_LOCK = path.join(STATE_DIR, "pending-signals.lock");
  // Pending Telegram payloads — collected inside the lock, fired after release.
  const tgPayloads: string[] = [];
  let queuedSignals: LiveSignal[] = [];
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
      tgPayloads.push(
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
      // Phase 27 (Live Service Bug 11): re-read controls IMMEDIATELY before
      // writing so a Telegram /pause that arrived between the first read
      // (line ~685) and now is honored. Closes the small msec-window race
      // where a signal was queued despite an in-flight /pause command.
      const controlsRecheck = readControls(STATE_DIR);
      if (controlsRecheck.paused) {
        console.log(
          `[ftmo-live] /pause arrived during dedup — dropping ${newSignals.length} signal(s)`,
        );
        tgPayloads.push(
          `⏸ <b>${newSignals.length} signal(s) dropped</b> (pause arrived during processing)`,
        );
      } else {
        pending.signals.push(...newSignals);
        writeJSON(PENDING_PATH, pending);
        console.log(
          `[ftmo-live] queued ${newSignals.length} new signal(s) to ${PENDING_PATH}`,
        );
        queuedSignals = newSignals.slice();

        // Collect Telegram alert per new signal — fired AFTER lock release.
        for (const sig of newSignals) {
          const msg = [
            `🚨 <b>NEW SIGNAL</b>`,
            // Phase 23 (Auth Bug 7): htmlEscape symbol fields. Currently
            // these are enum-like, but a future custom-symbol config could
            // smuggle <tags> that break parse_mode=HTML or open phishing.
            `<b>${htmlEscape(sig.assetSymbol)}</b> (${htmlEscape(sig.sourceSymbol)}) — ${htmlEscape(sig.direction.toUpperCase())}`,
            `Entry: $${sig.entryPrice.toFixed(4)}`,
            `Stop: $${sig.stopPrice.toFixed(4)} (+${(sig.stopPct * 100).toFixed(2)}%)`,
            `TP: $${sig.tpPrice.toFixed(4)} (−${(sig.tpPct * 100).toFixed(2)}%)`,
            `Risk: ${(sig.riskFrac * 100).toFixed(3)}% · Factor ${sig.sizingFactor.toFixed(2)}×`,
            `Max hold: ${sig.maxHoldHours}h`,
          ].join("\n");
          tgPayloads.push(msg);
        }
      } // end of else (controlsRecheck.paused)
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
    // Phase 25 (Live Service Bug 13): use newSignals (post-dedup, post-pause)
    // so the heartbeat reflects what was actually QUEUED for execution, not
    // signals that were dropped (paused, dedup'd, blocked). Old behavior gave
    // false-positive 'OUT-OF-BAND Risk' flags during pause periods.
    if (queuedSignals.length > 0) {
      recordRecentSignals(queuedSignals);
    }
  }); // close withFileLock(PENDING_LOCK, ...)

  // Round 54 Fix #2: Telegram + smart-alert network calls run AFTER lock
  // release. A 6+ s 429-backoff in tgSend can no longer block Python's
  // read-modify-write on pending-signals.json.
  for (const msg of tgPayloads) {
    await tgSend(msg);
  }
  // Smart alerts (equity drop, DL/TL warnings, stuck challenge, daily summary,
  // risk heartbeat) — these also call tgSend internally, so they run outside
  // the lock too.
  await runSmartAlerts(account);

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

  // 1) Equity-drop alert: ≥2% drop normalized to a 1h window — works
  // regardless of polling frequency.
  // Phase 33 (Audit Bug 4): only UPDATE the snapshot AFTER evaluating the
  // alert. Previously the snapshot was unconditionally overwritten every
  // poll → on sub-10min polling cadences dt was always < 10min → alert
  // NEVER fired (silenced by Phase 31's min-dt gate). Snapshot now
  // accumulates until ≥10min has passed, then evaluates + resets.
  let updateSnapshot = false;
  if (state.lastEquitySnapshot) {
    const dtMs = now - state.lastEquitySnapshot.ts;
    if (dtMs >= 10 * 60_000 && dtMs <= 6 * 3600_000) {
      const drop = state.lastEquitySnapshot.equity - account.equity;
      const dropPerHour = drop / (dtMs / 3600_000);
      if (dropPerHour >= ALERT_EQUITY_DROP_PCT) {
        await tgSend(
          `📉 <b>EQUITY DROP ALERT</b>\n` +
            `Equity dropped ${(drop * 100).toFixed(2)}% over ${(dtMs / 3600_000).toFixed(1)}h ` +
            `(rate: ${(dropPerHour * 100).toFixed(2)}%/h)\n` +
            `From ${(state.lastEquitySnapshot.equity * 100).toFixed(2)}% → ${(account.equity * 100).toFixed(2)}%\n` +
            `Day ${account.day} of challenge`,
        );
      }
      updateSnapshot = true;
    } else if (dtMs > 6 * 3600_000) {
      // Snapshot is stale — refresh it.
      updateSnapshot = true;
    }
  } else {
    // No prior snapshot — initialize.
    updateSnapshot = true;
  }
  if (updateSnapshot) {
    state.lastEquitySnapshot = { ts: now, equity: account.equity };
  }

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
  // Round 60 (Audit Round 3, Task B): refuse to start if another signal
  // service is already running on this state dir. MUST happen before
  // ensureStateDir/Telegram bring-up so a duplicate launch never opens a
  // second long-poll on the same bot token. Mirrors Python executor's
  // `acquire_singleton_or_exit()` (tools/ftmo_executor.py:2965).
  const lock = acquireSingletonLock(STATE_DIR);
  if (!lock.acquired) {
    console.error(`[ftmo-live] ${lock.reason}. Refusing to start.`);
    process.exit(11);
  }
  ensureStateDir();

  // Round 54 Fix #3: assert CFG selection at boot. V231's getActiveCfgInfo()
  // throws inside the module if FTMO_TF was set but didn't match any
  // registry key — this banner adds a confirmation log so the operator
  // sees `resolved CFG=<label> for FTMO_TF=<env>` and can spot drift
  // (e.g. a config rename that wasn't propagated to the registry).
  const cfgInfo = getActiveCfgInfo();
  const ftmoTfEnv = process.env.FTMO_TF ?? "(unset)";
  console.log(
    `[ftmo-live] resolved CFG=${cfgInfo.label} for FTMO_TF=${ftmoTfEnv}`,
  );
  if (process.env.FTMO_TF && cfgInfo.ftmoTfKey === "") {
    console.error(
      `[ftmo-live] WARNING: FTMO_TF=${process.env.FTMO_TF} resolved to empty key — check trim/whitespace`,
    );
  }

  await tgSend(
    `🤖 <b>FTMO Signal Service ONLINE (${TF})</b>\nState dir: <code>${htmlEscape(STATE_DIR)}</code>\nCFG: ${htmlEscape(cfgInfo.label)} (FTMO_TF=${htmlEscape(ftmoTfEnv)})\nNext check at next ${TF} UTC boundary.`,
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
