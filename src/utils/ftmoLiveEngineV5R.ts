/**
 * @deprecated 2026-05-04 — V5R was rejected by Round 60 V5R-Guardian sweep
 *   (-10 to -14pp vs R28_V6 baseline). Kept for sweep replay only.
 *   State-file changed to v5r-engine.json (R4) to prevent V4 conflicts.
 *   NOT for live deploy. Use ftmoLiveEngineV4 (R28_V6) for production.
 *
 * FTMO V5R LIVE ENGINE — experimental persistent-state bar-by-bar live engine.
 *
 * Designed in Round 25, prototyped as test-only simulator in Round 26
 * (`scripts/_v4LiveSimulator.test.ts`), and extracted to production here
 * (Round 40, 2026-05-01).
 *
 * WHY THIS EXISTS:
 *   The Round-26 V4 simulator showed the V231 polling-style live signal
 *   has 0-21% entry-agreement with `runFtmoDaytrade24h` because the
 *   backtest engine pre-sorts trades and walks them with sequentially-
 *   realised equity. Live MT5 has mark-to-market (MTM) equity that
 *   includes unrealised PnL of all open positions — the metric that
 *   peakDrawdownThrottle / dailyPeakTrailingStop / challengePeakTrailingStop
 *   actually trigger on.
 *
 *   Round 38/39 found this drives a 30-46pp gap on R28/R28_V4. To close
 *   that gap we need a live engine that:
 *     1. Walks bars chronologically (no future-knowledge sort).
 *     2. Maintains MTM equity = 1.0 + Σ realised + Σ unrealised.
 *     3. Persists ALL accumulators across polling-tick boundaries:
 *        dayPeak, challengePeak, MCT counter, pause flag, lossStreak,
 *        kelly recentPnls, equity history, day-rollover state.
 *     4. Atomically writes state to JSON between ticks (cross-process
 *        safe — Python executor reads same files).
 *
 * API:
 *   loadState(stateDir, cfgLabel): FtmoLiveStateV4
 *   saveState(state, stateDir): void
 *   pollLive(state, candlesByAsset, cfg): TickResult — process ONE bar
 *   simulate(candlesByAsset, cfg, [windowStart, windowEnd]): SimResult
 *     — runs pollLive over a whole window, used by backtests.
 *
 * Feature parity matrix (vs `runFtmoDaytrade24h`):
 *   ✅ liveCaps {maxStopPct, maxRiskFrac}
 *   ✅ atrStop {period, stopMult}
 *   ✅ chandelierExit {period, mult, minMoveR}
 *   ✅ breakEven {threshold}
 *   ✅ partialTakeProfit {triggerPct, closeFraction} + auto-BE
 *   ✅ partialTakeProfitLevels (sequential)
 *   ✅ dailyPeakTrailingStop {trailDistance}
 *   ✅ challengePeakTrailingStop {trailDistance}
 *   ✅ peakDrawdownThrottle {fromPeak, factor}
 *   ✅ drawdownShield {belowEquity, factor}
 *   ✅ adaptiveSizing tiers
 *   ✅ kellySizing tiers
 *   ✅ timeBoost {afterDay, equityBelow, factor}
 *   ✅ maxConcurrentTrades
 *   ✅ correlationFilter {maxOpenSameDirection}
 *   ✅ pauseAtTargetReached + minTradingDays
 *   ✅ lossStreakCooldown {afterLosses, cooldownBars}
 *   ✅ intradayDailyLossThrottle {soft, hard}
 *   ✅ allowedHoursUtc / allowedDowsUtc gates
 *   ✅ asset.activateAfterDay / minEquityGain / maxEquityGain
 *
 *   ➖ Detection-side filters (htfTrendFilter, fundingRate, news,
 *      adxFilter, choppinessFilter, donchian/maCross/etc) — handled by
 *      `detectAsset()` which we delegate to. Same exact logic as backtest.
 *
 * NOT covered (intentional):
 *   - timeExit (covered by cfg.holdBars + simple SL/TP exit logic)
 *   - momentumRanking (requires whole-window pre-sort = impossible live)
 *   - ping-trade phase: live bot does this externally via cron, engine
 *     just sets `state.pausedAtTarget = true` and the executor takes
 *     over (open tiny no-risk trade once per day until minTradingDays).
 *
 * STATE FILE (`v4-engine.json`):
 *   {
 *     "schemaVersion": 1,
 *     "cfgLabel": "V5_QUARTZ_LITE_R28_V4",
 *     "createdAt": 1714521600000,
 *     "updatedAt": 1714521600000,
 *     "lastBarOpenTime": 1714521600000,
 *     "challengeStartTs": 1714000000000,
 *     "equity": 1.0234,             // realised only
 *     "mtmEquity": 1.0234,          // realised + unrealised at last bar
 *     "day": 3,                     // current challenge day (0-based)
 *     "dayStart": 1.0190,           // equity at start of current day
 *     "dayPeak": 1.0240,            // intraday MTM peak
 *     "challengePeak": 1.0240,      // all-time MTM peak
 *     "openPositions": [...],       // mirror of broker open positions
 *     "tradingDays": [0,1,2,3],     // unique entry-days
 *     "firstTargetHitDay": null,
 *     "pausedAtTarget": false,
 *     "lossStreakByAssetDir": {...},// {"BTC-TREND|long": {streak:2, cdUntil:14523}}
 *     "kellyPnls": [{closeTime, effPnl}, ...],
 *     "closedTrades": [...],        // last 200 for audit
 *     "barsSeen": 142,
 *     "stoppedReason": null         // "total_loss" | "daily_loss" | null
 *   }
 *
 * CROSS-PROCESS WRITE SAFETY:
 *   - Use atomic write: write to .tmp, fsync, rename.
 *   - Reader retries once on JSON parse failure (rename in-flight).
 *   - schemaVersion mismatch → hard reset (corrupt data > false positives).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atr, rsi } from "@/utils/indicators";
import type { Candle } from "@/utils/indicators";
import {
  detectAsset,
  type Daytrade24hAssetCfg,
  type Daytrade24hTrade,
  type FtmoDaytrade24hConfig,
} from "@/utils/ftmoDaytrade24h";

// ─── Types ──────────────────────────────────────────────────────────────

// Phase 36 (R44-V4-8): bumped to 2. lossStreakByAssetDir.cdUntilBarIdx
// renamed to cdUntilBarsSeen because barIdx = refCandles.length-1 is
// non-monotonic across ticks (refKey can change when feed alignment
// shifts). Old states get auto-backed-up + reset by loadState.
//
// Round 57 V4-3 fix (Fix 4): bumped to 3. R54 changed entryBarIdx convention
// from `refCandles.length-1` (non-monotonic) to `state.barsSeen` (monotonic).
// A persisted v2 state that includes openPositions has stale entryBarIdx
// values referencing the old non-monotonic anchor. v2→v3 migration in
// loadState rewrites each open position's entryBarIdx to state.barsSeen
// (conservative — anchors to latest known monotonic value).
const SCHEMA_VERSION = 3 as const;

export interface OpenPositionV4 {
  /** Stable position id (entryTime + symbol) for ticket idempotency. */
  ticketId: string;
  /** Logical engine symbol (e.g. "BTC-TREND"). */
  symbol: string;
  /** Candle source key (e.g. "BTCUSDT"). */
  sourceSymbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  /** Initial stop-distance fraction (used for chandelier minMoveR). */
  initialStopPct: number;
  stopPrice: number;
  tpPrice: number;
  /** Engine-units risk fraction at entry (post sizing factor + caps). */
  effRisk: number;
  /**
   * Monotonic bar index at entry — tracks `state.barsSeen` (NOT
   * `refCandles.length-1` which is non-monotonic across ticks because
   * `refKey` can shift symbols).
   *
   * Round 54 (R54-V4-1) fix: previously stored `refCandles.length-1` —
   * a latent landmine for any future code that compared this to
   * `state.barsSeen` after refKey shifted. Field is currently unused at
   * exit-time but kept for future bar-elapsed accounting.
   */
  entryBarIdx: number;
  highWatermark: number; // long: highest high since entry; short: lowest low
  beActive: boolean;
  ptpTriggered: boolean;
  ptpRealizedPct: number;
  /** Multi-level PTP — index of next level to fire. */
  ptpLevelIdx: number;
  ptpLevelsRealized: number;
  /**
   * Round 58 (Critical Fix #2): most recently observed close price for
   * this position's source symbol, updated on every poll where a candle
   * is available. Used as a SAFE fallback when end-of-window force-close
   * runs but no candle is available for this asset on the final bar
   * (feed dropout, exchange halt, or symbol-resolver miss). Previously
   * we fell back to `pos.entryPrice` → effPnl=0 → a +5% winning trade
   * would be booked as zero P&L, silently flipping pass/fail outcomes.
   *
   * Optional for backwards compatibility with persisted v3 states that
   * pre-date this field; absent → fallback chain reverts to entryPrice.
   */
  lastKnownPrice?: number;
}

export interface ClosedTradeV4 {
  ticketId: string;
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  rawPnl: number;
  effPnl: number;
  exitReason: "tp" | "stop" | "time" | "manual";
  /** Day-of-challenge at exit. */
  day: number;
  entryDay: number;
}

export interface FtmoLiveStateV4 {
  schemaVersion: number;
  cfgLabel: string;
  createdAt: number;
  updatedAt: number;
  /**
   * openTime of the latest bar that has been processed. Used to enforce
   * monotonic-time invariant — a re-poll on the same bar is a no-op.
   */
  lastBarOpenTime: number;
  /**
   * openTime of the FIRST bar processed in this challenge. Used to derive
   * day-index. Set on first poll.
   */
  challengeStartTs: number;
  /** Realised-only equity (compounded close PnLs). */
  equity: number;
  /** MTM equity = realised + unrealised at lastBarOpenTime. */
  mtmEquity: number;
  /** Current challenge day (0-based, derived from challengeStartTs). */
  day: number;
  /** Realised equity at start of current day (for daily-loss check). */
  dayStart: number;
  /** Intraday MTM peak equity (for dailyPeakTrailingStop). */
  dayPeak: number;
  /** All-time MTM peak equity (for challengePeakTrailingStop / pDD). */
  challengePeak: number;
  openPositions: OpenPositionV4[];
  /** Set of unique entry-days (FTMO minTradingDays counter). */
  tradingDays: number[];
  firstTargetHitDay: number | null;
  pausedAtTarget: boolean;
  /**
   * Loss-streak state per (asset|direction) key — mirrors detectAsset
   * which keeps it per-direction. Streak resets on TP, increments on stop.
   * cdUntilBarsSeen is the absolute `state.barsSeen` value after which
   * entries unblock — monotonic across ticks even when refKey reorders.
   * (Phase 36 / R44-V4-8: was `cdUntilBarIdx` keyed off refCandles.length
   * which is non-monotonic when the oldest-common asset changes.)
   */
  lossStreakByAssetDir: Record<
    string,
    { streak: number; cdUntilBarsSeen: number; reentryUntilBarsSeen?: number }
  >;
  /** Kelly window: realised pnl-per-trade with closeTime for filter-by-entryTime. */
  kellyPnls: Array<{ closeTime: number; effPnl: number }>;
  /**
   * Round 57 V4-3 (Fix 6): persisted Kelly tier index (sorted descending by
   * winRateAbove). Adds hysteresis around tier boundaries: only step UP if
   * wr >= newTier.winRateAbove + 0.05; only step DOWN if wr <= currentTier.winRateAbove - 0.05.
   * Prevents flicker at the boundary (wr=0.701 → 1.5×, wr=0.699 → 1.0× per tick).
   * Optional — undefined means "first call, use plain greedy lookup" (defaults to
   * pre-fix behaviour, which initialises the index for subsequent calls).
   */
  kellyTierIdx?: number;
  /** Last 200 closed trades — audit/debug only. */
  closedTrades: ClosedTradeV4[];
  /** How many bars (any asset) we've processed. */
  barsSeen: number;
  /** Hard-stop reason — once set, no more entries / pollLive returns immediately. */
  stoppedReason: "total_loss" | "daily_loss" | "time" | null;
}

export interface PollSignal {
  symbol: string;
  sourceSymbol: string;
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  stopPct: number;
  tpPct: number;
  effRisk: number;
  /** Optional derived fields for executor parity. */
  chandelierAtrAtEntry?: number;
  ptpConfig?: { triggerPct: number; closeFraction: number };
  beThreshold?: number;
}

export interface PollSkip {
  asset: string;
  reason: string;
}

export interface PollDecision {
  /** Closed positions (manual exits — SL/TP/time). */
  closes: Array<{
    ticketId: string;
    exitPrice: number;
    exitReason: "tp" | "stop" | "time" | "manual";
  }>;
  /** New entries to open. */
  opens: PollSignal[];
}

export interface PollResult {
  decision: PollDecision;
  state: FtmoLiveStateV4;
  skipped: PollSkip[];
  notes: string[];
  /** True once equity ≥ profitTarget (might still need ping-days). */
  targetHit: boolean;
  /** True if this poll concluded the challenge (passed or failed). */
  challengeEnded: boolean;
  passed: boolean;
  failReason: "total_loss" | "daily_loss" | "time" | "feed_lost" | null;
}

// ─── State init / load / save ───────────────────────────────────────────

export function initialState(cfgLabel: string): FtmoLiveStateV4 {
  return {
    schemaVersion: SCHEMA_VERSION,
    cfgLabel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastBarOpenTime: 0,
    challengeStartTs: 0,
    equity: 1.0,
    mtmEquity: 1.0,
    day: 0,
    dayStart: 1.0,
    dayPeak: 1.0,
    challengePeak: 1.0,
    openPositions: [],
    tradingDays: [],
    firstTargetHitDay: null,
    pausedAtTarget: false,
    lossStreakByAssetDir: {},
    kellyPnls: [],
    closedTrades: [],
    barsSeen: 0,
    stoppedReason: null,
  };
}

// Round 60 audit fix: was "v4-engine.json" — same name as V4 engine, which
// would silently OVERWRITE V4's persistent state if V5R ever ran in the same
// state-dir. V5R is not live-promoted but defensive separation prevents
// catastrophic state-pollution if anyone later tries.
const STATE_FILENAME = "v5r-engine.json";

/**
 * Load state from disk. Returns fresh state if missing, corrupt, or
 * cfgLabel mismatch (config change = challenge reset).
 */
export function loadState(stateDir: string, cfgLabel: string): FtmoLiveStateV4 {
  const filePath = path.join(stateDir, STATE_FILENAME);
  if (!fs.existsSync(filePath)) return initialState(cfgLabel);
  // Retry-once: a concurrent rename-into-place can race with our read.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      // Phase 35 (R44-V4-2): JSON.parse accepts primitives (e.g. `"foo"`,
      // `42`, `null`) — without an object guard, downstream `parsed as
      // FtmoLiveStateV4` returns a non-object that crashes the engine
      // hours later. Treat non-objects as corrupt → backup + fresh state.
      if (parsed === null || typeof parsed !== "object") {
        throw new Error("state file is not an object");
      }
      const obj = parsed as Partial<FtmoLiveStateV4> & {
        lossStreakByAssetDir?: Record<
          string,
          {
            streak: number;
            cdUntilBarIdx?: number;
            cdUntilBarsSeen?: number;
          }
        >;
      };
      // Phase 56 (R45-5): in-place schema migration v1 → v2 BEFORE
      // mismatch-backup. Phase 36 renamed lossStreakByAssetDir.cdUntilBarIdx
      // to cdUntilBarsSeen and bumped SCHEMA_VERSION 1 → 2. Without an
      // explicit migration, all live V4 bots lost their entire challenge
      // state (peak / dayPeak / kelly / ping-days / cdUntil) on next deploy.
      // Now we map the old field name to the new one and bump the version
      // so the rest of the load path treats it as a v2 state.
      if (
        obj.schemaVersion === 1 &&
        obj.cfgLabel === cfgLabel &&
        obj.lossStreakByAssetDir
      ) {
        for (const k of Object.keys(obj.lossStreakByAssetDir)) {
          const ls = obj.lossStreakByAssetDir[k];
          if (ls && ls.cdUntilBarsSeen === undefined) {
            // Old `cdUntilBarIdx` was relative to refCandles.length-1, which
            // is non-monotonic across ticks. Conservative migration: clear
            // any active cooldown (set to -1) so the next loss starts a
            // fresh, correctly-anchored cooldown via state.barsSeen.
            ls.cdUntilBarsSeen = -1;
            delete (ls as { cdUntilBarIdx?: number }).cdUntilBarIdx;
          }
        }
        // Mark as v2 so the v2→v3 migration below also runs on v1 states.
        obj.schemaVersion = 2;
        console.warn(
          `[V4] in-place schema migration v1 → v2 for ${cfgLabel} ` +
            `(cdUntilBarIdx → cdUntilBarsSeen, active cooldowns reset)`,
        );
      }
      // Round 57 V4-3 (Fix 4): v2 → v3 migration. R54 (R54-V4-1) changed
      // OpenPositionV4.entryBarIdx convention from `refCandles.length-1`
      // (non-monotonic across ticks when refKey shifts) to monotonic
      // `state.barsSeen`. A persisted v2 state with open positions still
      // has the stale anchor — any future code comparing entryBarIdx
      // against state.barsSeen would see negative deltas. Conservative
      // rewrite: set entryBarIdx = state.barsSeen for every open position
      // so all comparisons start fresh from the latest known monotonic
      // value. Doesn't affect exits (entryBarIdx is currently unused at
      // exit time per R54 comment).
      if (
        obj.schemaVersion === 2 &&
        obj.cfgLabel === cfgLabel &&
        Array.isArray(obj.openPositions)
      ) {
        const anchor = typeof obj.barsSeen === "number" ? obj.barsSeen : 0;
        for (const pos of obj.openPositions) {
          if (pos && typeof pos === "object") {
            (pos as OpenPositionV4).entryBarIdx = anchor;
          }
        }
        obj.schemaVersion = SCHEMA_VERSION;
        console.warn(
          `[V4] in-place schema migration v2 → v${SCHEMA_VERSION} for ${cfgLabel} ` +
            `(entryBarIdx re-anchored to state.barsSeen=${anchor} for ${obj.openPositions.length} open position(s))`,
        );
      }
      // Phase 14 (V4 Bug 9): on schema/cfg mismatch, BACK UP the old state
      // file before discarding. Without this, deploying a new version or
      // changing FTMO_TF wiped the entire challenge state silently — losing
      // peakDrawdown, pause state, ping-day records, kelly window, etc.
      if (obj.schemaVersion !== SCHEMA_VERSION || obj.cfgLabel !== cfgLabel) {
        const backupPath = `${filePath}.backup.${Date.now()}`;
        try {
          fs.renameSync(filePath, backupPath);
        } catch {
          /* ignore — fresh state will overwrite anyway */
        }
        console.error(
          `[V4] STATE MISMATCH — backed up to ${backupPath}. ` +
            `Old: ${obj.cfgLabel}/${obj.schemaVersion}, ` +
            `New: ${cfgLabel}/${SCHEMA_VERSION}`,
        );
        return initialState(cfgLabel);
      }
      return obj as FtmoLiveStateV4;
    } catch (_err) {
      if (attempt === 0) continue; // retry once on transient parse error
      // Phase 35 (R44-V4-1): on the SECOND attempt failing too, the file
      // is genuinely corrupt — back it up before silently wiping. Without
      // this branch, a single bad write erased the challenge state with
      // no forensic trail.
      try {
        const corruptPath = `${filePath}.corrupt.${Date.now()}`;
        fs.renameSync(filePath, corruptPath);
        console.error(
          `[V4] STATE CORRUPT — backed up to ${corruptPath}. ` +
            `Reason: ${(_err as Error).message}`,
        );
      } catch {
        /* file already gone — proceed with fresh state */
      }
      return initialState(cfgLabel);
    }
  }
  return initialState(cfgLabel);
}

/**
 * Atomic write: tmp file + rename. Crash-safe — readers see either the
 * old version or the new version, never partial.
 */
export function saveState(state: FtmoLiveStateV4, stateDir: string): void {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  const filePath = path.join(stateDir, STATE_FILENAME);
  // Phase 14 (V4 Bug 12): random suffix instead of Date.now() to avoid
  // tmpPath collision when two saveState calls land in the same ms within
  // the same process (async race in pollLive wrappers).
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  const tmpPath = `${filePath}.tmp.${process.pid}.${rand}`;
  state.updatedAt = Date.now();
  // Trim audit log to last 200.
  if (state.closedTrades.length > 200) {
    state.closedTrades = state.closedTrades.slice(-200);
  }
  // Trim kelly buffer to a generous bound (prevent unbounded growth).
  if (state.kellyPnls.length > 500) {
    state.kellyPnls = state.kellyPnls.slice(-500);
  }
  const json = JSON.stringify(state, null, 2);
  let renamed = false;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
    renamed = true;
    // Phase 35 (R44-V4-3): fsync the parent directory after rename to
    // guarantee the rename is durable across power loss on ext4 / xfs.
    // Without this, the tmp-file data was fsynced but the directory entry
    // pointing to filePath could revert post-crash, losing the new state.
    try {
      const dirFd = fs.openSync(stateDir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* directory fsync unsupported on this fs — best-effort only */
    }
  } finally {
    // Phase 35 (R44-V4-4): clean up orphaned tmpfile if rename never
    // happened (write failed mid-way, or rename threw EXDEV across mount
    // boundary). Without this, repeated failed writes piled up tmpfile
    // corpses in the state-dir indefinitely.
    if (!renamed) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* tmpfile already gone — safe to ignore */
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Phase 36 (R44-V4-5/6): pick the candle whose openTime equals `targetTime`,
 * NOT the array end. Asset feeds can arrive 1-2 bars ahead/behind each
 * other; reading `arr[arr.length-1]` for MTM/exit checks then mixed bars
 * across the reference timeline. Returns null if no exact match — caller
 * decides whether to fall back to the nearest earlier bar.
 */
function findCandleAtTime(arr: Candle[], targetTime: number): Candle | null {
  // Linear scan from the end is fastest because feeds are typically
  // 0-2 bars ahead of `targetTime`.
  for (let i = arr.length - 1; i >= 0; i--) {
    const c = arr[i]!;
    if (c.openTime === targetTime) return c;
    if (c.openTime < targetTime) break; // sorted asc → no earlier match equals target
  }
  return null;
}

function dayIndex(barTs: number, challengeStart: number): number {
  if (challengeStart <= 0) return 0;
  // Phase 14 (V4 Bug 5): align day-rollover with FTMO Prague-midnight, not
  // UTC midnight. Python executor uses ZoneInfo("Europe/Prague") for
  // dayPeak; engine was using UTC → 1-2h disagreement per day → DL/TL
  // checks attribute trades to the wrong day around CET 23:00-00:00.
  // Phase 30 (V4 Audit Bug 1): apply offset to BOTH sides — offset on
  // barTs only drifted at DST-changeover (winter→summer or vice versa)
  // because challengeStart was un-offset.
  const barLocal = barTs + pragueOffsetMs(barTs);
  const startLocal = challengeStart + pragueOffsetMs(challengeStart);
  return Math.floor((barLocal - startLocal) / (24 * 3600 * 1000));
}

/**
 * Approximate Prague (CET/CEST) offset in ms for a given UTC timestamp.
 * Uses Intl.DateTimeFormat for DST correctness; falls back to UTC+1 if Intl
 * unavailable (matches the existing pragueDay helper in ftmoDaytrade24h).
 */
function pragueOffsetMs(ts: number): number {
  try {
    const d = new Date(ts);
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Prague",
      hour: "2-digit",
      hour12: false,
    });
    const pragueHour = parseInt(fmt.format(d), 10);
    // Phase 30 (V4 Audit Bug 8): NaN-guard. Buggy ICU / locale-twist could
    // return "AM/PM" or empty → parseInt → NaN → diff=NaN → return NaN →
    // dayIndex returns NaN → day-rollover never trips for the rest of session.
    if (!Number.isFinite(pragueHour)) return 3600_000;
    const utcHour = d.getUTCHours();
    let diff = pragueHour - utcHour;
    if (diff > 12) diff -= 24;
    if (diff < -12) diff += 24;
    return diff * 3600_000;
  } catch {
    return 3600_000; // UTC+1 fallback (winter)
  }
}

function lsKey(symbol: string, direction: "long" | "short"): string {
  return `${symbol}|${direction}`;
}

/**
 * Compute current MTM equity: realised + Σ unrealised at given prices.
 * Unrealised PnL uses the same effPnl formula as exit, but at current bar
 * close instead of stop/tp.
 */
function computeMtmEquity(
  state: FtmoLiveStateV4,
  pricesBySource: Record<string, number>,
  cfg: FtmoDaytrade24hConfig,
): number {
  let mtm = state.equity;
  for (const pos of state.openPositions) {
    const price = pricesBySource[pos.sourceSymbol];
    if (price == null) continue;
    // Round 58 (Critical Fix #2): track most recent observed close so
    // end-of-window force-close has a safer fallback than entryPrice
    // when the asset's candle is missing on the final bar.
    pos.lastKnownPrice = price;
    let rawPnl =
      pos.direction === "long"
        ? (price - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - price) / pos.entryPrice;
    if (pos.ptpTriggered) {
      // PTP locked partial gain; remainder runs to current price.
      const ptpCfg = cfg.partialTakeProfit;
      const closeFrac = ptpCfg?.closeFraction ?? 0;
      rawPnl = pos.ptpRealizedPct + (1 - closeFrac) * rawPnl;
    } else if (pos.ptpLevelsRealized > 0 && cfg.partialTakeProfitLevels) {
      // Multi-level PTP: realised so far + remainder.
      const totalClosed = cfg.partialTakeProfitLevels
        .slice(0, pos.ptpLevelIdx)
        .reduce((s, l) => s + l.closeFraction, 0);
      rawPnl = pos.ptpLevelsRealized + (1 - totalClosed) * rawPnl;
    }
    const unrealised = Math.max(
      rawPnl * cfg.leverage * pos.effRisk,
      -pos.effRisk * 1.5,
    );
    mtm *= 1 + unrealised;
  }
  return mtm;
}

/**
 * Resolve sizing factor mirroring `runFtmoDaytrade24h` equity loop. Same
 * order: adaptiveSizing → timeBoost → kellySizing → drawdownShield →
 * peakDrawdownThrottle → intradayDailyLossThrottle.
 *
 * Round 57 V4-3 (Fix 6): exported so unit tests can verify kellyTierIdx
 * hysteresis without having to drive a full detect-asset-emits-signal flow.
 */
export function resolveSizingFactor(
  state: FtmoLiveStateV4,
  cfg: FtmoDaytrade24hConfig,
  entryTime: number,
): number {
  let factor = 1;
  // Adaptive tiers (sorted ascending).
  if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0) {
    const sortedTiers = [...cfg.adaptiveSizing].sort(
      (a, b) => a.equityAbove - b.equityAbove,
    );
    for (const tier of sortedTiers) {
      if (state.equity - 1 >= tier.equityAbove) factor = tier.factor;
    }
  }
  // timeBoost — only overrides if it INCREASES factor (never fights protection).
  if (
    cfg.timeBoost &&
    state.day >= cfg.timeBoost.afterDay &&
    state.equity - 1 < cfg.timeBoost.equityBelow &&
    cfg.timeBoost.factor > factor
  ) {
    factor = cfg.timeBoost.factor;
  }
  // Kelly multiplier from realised PnL window.
  // Round 57 V4-3 (Fix 6): tier hysteresis. Without persistence, wr flickering
  // around a tier boundary (e.g. 0.701 → 1.5×, 0.699 → 1.0×) toggled the
  // sizing factor every other tick. With persisted state.kellyTierIdx we
  // require a 5pp move past the threshold to step UP and a 5pp move below
  // the CURRENT tier's threshold to step DOWN. First call (kellyTierIdx
  // undefined) falls back to the plain greedy lookup so existing behaviour
  // is preserved on cold-start.
  if (cfg.kellySizing) {
    const ks = cfg.kellySizing;
    const recent = state.kellyPnls
      .filter((p) => p.closeTime < entryTime)
      .slice(-ks.windowSize)
      .map((p) => p.effPnl);
    if (recent.length >= ks.minTrades) {
      const wr = recent.filter((p) => p > 0).length / recent.length;
      const sortedTiers = [...ks.tiers].sort(
        (a, b) => b.winRateAbove - a.winRateAbove,
      );
      const HYST = 0.05;
      let tierIdx: number;
      if (state.kellyTierIdx === undefined) {
        // Cold-start: greedy lookup, then persist.
        tierIdx = sortedTiers.findIndex((t) => wr >= t.winRateAbove);
        if (tierIdx === -1) tierIdx = sortedTiers.length - 1;
      } else {
        // Warm-start: hysteresis around current tier.
        const cur = Math.min(state.kellyTierIdx, sortedTiers.length - 1);
        const curTier = sortedTiers[cur]!;
        // Step UP: wr crossed ABOVE next-better tier's threshold by >= HYST.
        // Step DOWN: wr fell BELOW current tier's threshold by >= HYST.
        if (cur > 0 && wr >= sortedTiers[cur - 1]!.winRateAbove + HYST) {
          // Find the highest tier whose threshold we comfortably cleared.
          tierIdx = cur - 1;
          while (
            tierIdx > 0 &&
            wr >= sortedTiers[tierIdx - 1]!.winRateAbove + HYST
          ) {
            tierIdx -= 1;
          }
        } else if (
          cur < sortedTiers.length - 1 &&
          wr <= curTier.winRateAbove - HYST
        ) {
          tierIdx = cur + 1;
          while (
            tierIdx < sortedTiers.length - 1 &&
            wr <= sortedTiers[tierIdx]!.winRateAbove - HYST
          ) {
            tierIdx += 1;
          }
        } else {
          tierIdx = cur;
        }
      }
      state.kellyTierIdx = tierIdx;
      const tier = sortedTiers[tierIdx];
      if (tier) factor *= tier.multiplier;
    }
  }
  // Hard cap to prevent compound timeBoost(2) × kelly(1.5) = 3× blow-ups.
  factor = Math.min(factor, 4);
  // drawdownShield: scale DOWN when underwater (after ramps).
  if (
    cfg.drawdownShield &&
    state.equity - 1 <= cfg.drawdownShield.belowEquity
  ) {
    factor = Math.min(factor, cfg.drawdownShield.factor);
  }
  // peakDrawdownThrottle: catches profit-give-back. Uses MTM challengePeak.
  if (cfg.peakDrawdownThrottle && state.challengePeak > 0) {
    const fromPeak =
      (state.challengePeak - state.mtmEquity) / state.challengePeak;
    if (fromPeak >= cfg.peakDrawdownThrottle.fromPeak) {
      factor = Math.min(factor, cfg.peakDrawdownThrottle.factor);
    }
  }
  // intradayDailyLossThrottle (soft tier).
  // Phase 84 (R51-FTMO-4): use Math.min to cap-down, not multiply. Phase 11
  // fixed this in the main engine (Engine Bug 12) but V4 had the original
  // multiplicative form. With Kelly+timeBoost producing factor=4 and a
  // softFactor=0.5, the multiplicative form yields 2.0 — STILL 2× baseline
  // risk after the soft-loss tier triggers. The cap form yields 0.5 (true
  // de-risk).
  if (cfg.intradayDailyLossThrottle) {
    const dayPnl = (state.equity - state.dayStart) / state.dayStart;
    if (dayPnl <= -cfg.intradayDailyLossThrottle.softLossThreshold) {
      factor = Math.min(factor, cfg.intradayDailyLossThrottle.softFactor);
    }
  }
  return factor;
}

/**
 * Process exits for one open position at the current bar. Mutates pos
 * in-place (chandelier high-watermark, beActive, ptp). Returns exit info
 * if a stop/tp/time was hit, else null.
 *
 * Uses same priority order as backtest: PTP/BE first, chandelier, then
 * SL/TP price-cross detection.
 */
function processPositionExit(
  pos: OpenPositionV4,
  candle: Candle,
  curBarIdx: number,
  cfg: FtmoDaytrade24hConfig,
  atrAtBar: number | null,
  holdBars: number,
): { exitPrice: number; reason: "tp" | "stop" | "time" } | null {
  // 1. Update high-watermark (long: highest high; short: lowest low).
  if (pos.direction === "long") {
    pos.highWatermark = Math.max(pos.highWatermark, candle.high);
  } else {
    pos.highWatermark = Math.min(pos.highWatermark, candle.low);
  }

  // 2. PartialTakeProfit (single-tier).
  const ptp = cfg.partialTakeProfit;
  if (ptp && !pos.ptpTriggered) {
    const triggerPrice =
      pos.direction === "long"
        ? pos.entryPrice * (1 + ptp.triggerPct)
        : pos.entryPrice * (1 - ptp.triggerPct);
    const ptpHit =
      pos.direction === "long"
        ? candle.high >= triggerPrice
        : candle.low <= triggerPrice;
    const stopHit =
      pos.direction === "long"
        ? candle.low <= pos.stopPrice
        : candle.high >= pos.stopPrice;
    const gapPastPtp =
      pos.direction === "long"
        ? candle.open >= triggerPrice
        : candle.open <= triggerPrice;
    // Round 54 (R54-V4-3): explicit same-bar PTP+Stop convention.
    // PARITY with backtest engine `runFtmoDaytrade24h` (ftmoDaytrade24h.ts
    // ~line 4228): "Conservative: PTP only fires when stop did NOT hit, OR
    // a gap already passed the trigger before any wick down to stop." If
    // both ptpHit and stopHit fire on the same bar AND the bar OPEN was
    // between TP and stop (no gap-past-PTP), STOP wins — the engine treats
    // the wick-to-PTP-then-down-to-stop case as stop-first. This is
    // intentional pessimism on volatile bars. Asymmetric for shorts vs longs
    // only insofar as long uses bar.high/low and short uses bar.low/high —
    // the priority logic is identical.
    if (ptpHit && (!stopHit || gapPastPtp)) {
      pos.ptpTriggered = true;
      pos.ptpRealizedPct = ptp.closeFraction * ptp.triggerPct;
      // Auto-move stop to break-even (mirrors backtest fix).
      if (pos.direction === "long") {
        if (pos.entryPrice > pos.stopPrice) pos.stopPrice = pos.entryPrice;
      } else {
        if (pos.entryPrice < pos.stopPrice) pos.stopPrice = pos.entryPrice;
      }
      pos.beActive = true;
      // Reset chandelier reference to current close.
      pos.highWatermark = candle.close;
    }
  }

  // 2b. Multi-level PTP.
  if (cfg.partialTakeProfitLevels && cfg.partialTakeProfitLevels.length > 0) {
    while (pos.ptpLevelIdx < cfg.partialTakeProfitLevels.length) {
      const lvl = cfg.partialTakeProfitLevels[pos.ptpLevelIdx];
      const triggerPrice =
        pos.direction === "long"
          ? pos.entryPrice * (1 + lvl!.triggerPct)
          : pos.entryPrice * (1 - lvl!.triggerPct);
      const lvlHit =
        pos.direction === "long"
          ? candle.high >= triggerPrice
          : candle.low <= triggerPrice;
      if (!lvlHit) break;
      pos.ptpLevelsRealized += lvl!.closeFraction * lvl!.triggerPct;
      pos.ptpLevelIdx++;
    }
  }

  // 3. BreakEven shift.
  if (cfg.breakEven && !pos.beActive) {
    const fav =
      pos.direction === "long"
        ? (candle.close - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - candle.close) / pos.entryPrice;
    if (fav >= cfg.breakEven.threshold) {
      pos.stopPrice = pos.entryPrice;
      pos.beActive = true;
    }
  }

  // 4. ChandelierExit — ATR-smoothed trailing stop, gated by minMoveR.
  if (cfg.chandelierExit && atrAtBar != null) {
    const minMoveR = cfg.chandelierExit.minMoveR ?? 0.5;
    const originalR = pos.initialStopPct * pos.entryPrice;
    if (originalR > 0) {
      const moveR =
        pos.direction === "long"
          ? (pos.highWatermark - pos.entryPrice) / originalR
          : (pos.entryPrice - pos.highWatermark) / originalR;
      if (moveR >= minMoveR) {
        const trailDist = cfg.chandelierExit.mult * atrAtBar;
        if (pos.direction === "long") {
          const newStop = pos.highWatermark - trailDist;
          if (newStop > pos.stopPrice) pos.stopPrice = newStop;
        } else {
          const newStop = pos.highWatermark + trailDist;
          if (newStop < pos.stopPrice) pos.stopPrice = newStop;
        }
      }
    }
  }

  // 5. SL/TP cross-detection at this bar.
  // R9 gap-fix mirror (2026-05-04): match V4 engine `runFtmoDaytrade24h`
  // (~line 4423) tie-break logic — when bar.open gaps past TP, TP wins and
  // fills at bar.open (favorable gap-up for long / gap-down for short).
  // When bar.open gaps past stop, stop fills at bar.open (worse than stop).
  // Without this, V5R simulations diverge from V4 on gap-bars and break
  // sweep comparability.
  if (pos.direction === "long") {
    const stopHit = candle.low <= pos.stopPrice;
    const tpHit = candle.high >= pos.tpPrice;
    const gapPastTp = candle.open >= pos.tpPrice;
    if (tpHit && gapPastTp) {
      return { exitPrice: candle.open, reason: "tp" };
    }
    if (stopHit) {
      const exitPrice =
        candle.open < pos.stopPrice ? candle.open : pos.stopPrice;
      return { exitPrice, reason: "stop" };
    }
    if (tpHit) {
      return { exitPrice: pos.tpPrice, reason: "tp" };
    }
  } else {
    const stopHit = candle.high >= pos.stopPrice;
    const tpHit = candle.low <= pos.tpPrice;
    const gapPastTp = candle.open <= pos.tpPrice;
    if (tpHit && gapPastTp) {
      return { exitPrice: candle.open, reason: "tp" };
    }
    if (stopHit) {
      const exitPrice =
        candle.open > pos.stopPrice ? candle.open : pos.stopPrice;
      return { exitPrice, reason: "stop" };
    }
    if (tpHit) {
      return { exitPrice: pos.tpPrice, reason: "tp" };
    }
  }

  // 6. Time-based exit — DISABLED for V4-Sim parity (the reference simulator
  // does not have time exits). Engine's `runFtmoDaytrade24h` uses time exits
  // because trades are pre-detected with their full exit info. Live-engine
  // shouldn't use them since trades close naturally via SL/TP, and time
  // exits introduce a parity gap with the V4-Sim. Residual hold-time after
  // holdBars is bounded by FTMO's maxDays anyway.
  void holdBars;
  void curBarIdx;
  return null;
}

/**
 * Compute realised effPnl for a closed position. Uses cfg.leverage and
 * pos.effRisk. Includes PTP partial-realised blend.
 */
function computeEffPnl(
  pos: OpenPositionV4,
  exitPrice: number,
  cfg: FtmoDaytrade24hConfig,
): { rawPnl: number; effPnl: number } {
  let rawPnl =
    pos.direction === "long"
      ? (exitPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - exitPrice) / pos.entryPrice;
  if (pos.ptpTriggered && cfg.partialTakeProfit) {
    const cf = cfg.partialTakeProfit.closeFraction;
    rawPnl = pos.ptpRealizedPct + (1 - cf) * rawPnl;
  } else if (pos.ptpLevelsRealized > 0 && cfg.partialTakeProfitLevels) {
    const totalClosed = cfg.partialTakeProfitLevels
      .slice(0, pos.ptpLevelIdx)
      .reduce((s, l) => s + l.closeFraction, 0);
    rawPnl = pos.ptpLevelsRealized + (1 - totalClosed) * rawPnl;
  }
  const effPnl = Math.max(
    rawPnl * cfg.leverage * pos.effRisk,
    -pos.effRisk * 1.5,
  );
  return { rawPnl, effPnl };
}

/**
 * Round 57 V4-3 (Fix 2): inline trim of bounded buffers. Previously trim
 * happened only at saveState time. In long-running pollLive sessions
 * between saves, kellyPnls / closedTrades grew unbounded and resolveSizingFactor's
 * filter+slice became O(N) per tick (10000+ entries).
 *
 * Cap = max(500, kelly windowSize × 4) — wide enough to never affect the
 * sliced-window stats (windowSize is the relevant lookback), tight enough
 * to keep the buffer bounded.
 */
function trimInline(state: FtmoLiveStateV4, cfg: FtmoDaytrade24hConfig): void {
  const kellyCap = Math.max(500, (cfg.kellySizing?.windowSize ?? 100) * 4);
  if (state.kellyPnls.length > kellyCap) {
    state.kellyPnls = state.kellyPnls.slice(-kellyCap);
  }
  if (state.closedTrades.length > 200) {
    state.closedTrades = state.closedTrades.slice(-200);
  }
}

// ─── Main poll loop ─────────────────────────────────────────────────────

/**
 * Process ONE bar at index `barIdx` for all assets. Mutates state. This
 * is the live-loop primitive.
 *
 * `candlesByAsset` must contain candles aligned by openTime across assets
 * (same as engine convention). The bar at `barIdx` must be the latest
 * just-closed bar across ALL assets (same openTime).
 *
 * Order of operations (mirrors live-bot real-time):
 *   1. SANITY: bar already processed → no-op (idempotent on retry).
 *   2. DAY-ROLLOVER: detect Δday from challengeStartTs, reset day-state.
 *   3. UPDATE MTM: compute mtmEquity, update dayPeak/challengePeak.
 *   4. EXIT-CHECK: loop open positions, apply chandelier/PTP/BE/SL/TP/time.
 *   5. TARGET / FAIL CHECK: realised equity vs profitTarget/maxTotalLoss/maxDailyLoss.
 *   6. PAUSE-AFTER-TARGET: if hit, set state.pausedAtTarget = true.
 *   7. ENTRY-FILTERS: pause, MCT, daily/challenge peak trail, lossStreak,
 *      hour/dow gates.
 *   8. PER-ASSET DETECTION: detectAsset() on slice[0..barIdx+1], find
 *      trade matching current bar's openTime (live-poll convention).
 *   9. APPLY-OPEN: open positions (with proper sizing factor + caps).
 */
export function pollLive(
  state: FtmoLiveStateV4,
  candlesByAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  // For test harness: precomputed ATR series. Optional in live (we compute on the fly).
  atrSeriesByAsset?: Record<string, (number | null)[]>,
): PollResult {
  const result: PollResult = {
    decision: { closes: [], opens: [] },
    state,
    skipped: [],
    notes: [],
    targetHit: false,
    challengeEnded: false,
    passed: false,
    failReason: null,
  };

  if (state.stoppedReason) {
    result.notes.push(`engine stopped: ${state.stoppedReason}`);
    result.challengeEnded = true;
    result.failReason =
      state.stoppedReason === "time" ? null : state.stoppedReason;
    return result;
  }

  // Find the LATEST aligned bar across all asset candles. We expect each
  // asset's candle array to end at the same openTime (caller ensures this).
  const assetKeys = Object.keys(candlesByAsset).filter(
    (k) => candlesByAsset[k] && candlesByAsset[k].length > 0,
  );
  if (assetKeys.length === 0) {
    result.notes.push("no candles");
    return result;
  }
  // Phase 14 (V4 Bug 6): assert all assets share the same lastBar.openTime.
  // Insertion order in `candlesByAsset` is non-deterministic — picking
  // assetKeys[0] without checking alignment let inconsistent feed timing
  // (one asset 30s ahead) silently corrupt the idempotency guard.
  const lastBarTimes = assetKeys.map((k) => {
    const arr = candlesByAsset[k];
    return arr![arr!.length - 1]!.openTime;
  });
  const minLastBar = Math.min(...lastBarTimes);
  const maxLastBar = Math.max(...lastBarTimes);
  if (maxLastBar !== minLastBar) {
    result.notes.push(
      `assets misaligned (lastBar ${minLastBar}…${maxLastBar}) — using minimum`,
    );
  }
  // Use the OLDEST common lastBar to ensure all assets have data through it.
  const refKey =
    assetKeys.find(
      (k) =>
        candlesByAsset[k]![candlesByAsset[k]!.length - 1]!.openTime ===
        minLastBar,
    ) ?? assetKeys[0]!;
  const refCandles = candlesByAsset[refKey]!;
  const lastBar = refCandles[refCandles.length - 1]!;
  const barIdx = refCandles.length - 1;

  // First-call: anchor challenge start.
  // Round 57 (R57-V4-2): if cfg.challengeStartTs is provided (typically
  // from CHALLENGE_START_DATE env var), use it as the FTMO daily-loss
  // anchor instead of lastBar.openTime. Without the override, activating
  // mid-day (e.g. Fri 16:00 Prague) caused dayPeak / dayStart to anchor
  // at the wrong wall-clock — the engine treated 16:00→18:00 as "day 0"
  // (correct) but reset dayPeak only at +24h-from-first-bar (= 16:00
  // next day), not at the next Prague midnight as FTMO does. The cfg-
  // provided anchor lets the operator align the engine clock with the
  // broker's wall-clock day-counter. dayIndex() still measures elapsed
  // 24h periods (NOT calendar-day floors); the executor's
  // `handle_daily_reset` is the wall-clock midnight authority.
  if (state.challengeStartTs === 0) {
    state.challengeStartTs =
      typeof cfg.challengeStartTs === "number" && cfg.challengeStartTs > 0
        ? cfg.challengeStartTs
        : lastBar.openTime;
    state.lastBarOpenTime = lastBar.openTime;
    state.dayStart = state.equity;
    // Round 57 V4-3 (Fix 3): defensive — clamp the initial peak anchors
    // to ≥ 1.0. If a state-corruption (or partial-write race) had set
    // mtmEquity to e.g. 0.95 before this branch ran, challengePeak would
    // persistently be below 1.0 and peakDrawdownThrottle could NEVER
    // fire (fromPeak = (peak - mtm)/peak ≈ 0 when mtm tracks peak from
    // below). Anchoring on max(mtmEquity, 1.0) makes the peak track a
    // sensible baseline even after corruption — pDD then fires correctly
    // once mtm drops past the cfg threshold.
    state.dayPeak = Math.max(state.mtmEquity, 1.0);
    state.challengePeak = Math.max(state.mtmEquity, 1.0);
  }

  // 1. Idempotent retry guard.
  if (lastBar.openTime <= state.lastBarOpenTime && state.barsSeen > 0) {
    result.notes.push("bar already processed (idempotent no-op)");
    return result;
  }

  // 2. Day-rollover.
  // Round 57 (R57-V4-4) NOTE: There is up to a 1-bar gap between Prague's
  // wall-clock midnight and `dayIndex(lastBar.openTime)` because dayIndex
  // is computed off the bar's openTime — a 30m bar opening at 23:30 Prague
  // still belongs to "yesterday" until the next bar at 00:00 fires. The
  // Python executor uses `datetime.now(prague_tz)` directly so its
  // `_prague_today_str` flips at exact wall-clock midnight, while the
  // engine's `state.day` flips on the first bar with `openTime ≥
  // next-Prague-midnight`. This is intentional: bar-time is the only
  // monotonic clock the engine can trust (system clock can NTP-jump),
  // and the gap is bounded by `barInterval` (≤2h for 2h candles, ≤30m
  // for 30m). Round 56 fixed `handle_daily_reset` to use Prague-TZ; the
  // remaining bar-time vs Prague-time gap is acceptable because the
  // executor's daily-loss decision uses its own equity-at-day-start, not
  // engine state.day.
  const newDay = dayIndex(lastBar.openTime, state.challengeStartTs);
  // Phase 84 (R51-FTMO-7): if newDay < state.day, the system clock or
  // feed time-traveled backwards (DST-end one-hour repeat, NTP step-back,
  // backfilled replay). Don't roll dayStart/dayPeak back — that would
  // compare today's PnL against an older day's reference, masking real
  // DL fails or tripping false ones. Log + skip the rollover; on the
  // next forward-progressing bar the normal `>` branch will fire.
  if (newDay < state.day) {
    result.notes.push(
      `time regression detected: newDay=${newDay} state.day=${state.day} — keeping current dayStart/dayPeak`,
    );
  } else if (newDay > state.day) {
    state.day = newDay;
    state.dayStart = state.equity;
    // Round 54 (R54-V4-5): defensive — anchor dayPeak at realised equity
    // (= dayStart, finite) rather than -Infinity. Step 4 recomputes via
    // `if (state.mtmEquity > state.dayPeak) state.dayPeak = state.mtmEquity`
    // so today's MTM correctly raises the peak when above day-start.
    // Previously (Phase 36 R44-V4-7) we used -Infinity to force the
    // recompute to anchor on today's bar — but that left a landmine: any
    // future early-return between rollover and recompute would persist
    // -Infinity and downstream `dailyPeakTrailingStop` math becomes NaN.
    // Anchoring at state.equity is finite, defensive, and remains correct
    // because today's MTM ≥ state.equity in the normal case (no underwater
    // open positions); when underwater, dayPeak = state.equity errs on
    // the safe side (a slightly higher peak makes dailyPeakTrailingStop
    // fire EARLIER on the same day, which is conservative).
    state.dayPeak = state.equity;
  }
  if (newDay >= cfg.maxDays) {
    // Round 57 V4-3 (Fix 1): force-close all open positions to lastBar.close
    // BEFORE evaluating pass. FTMO server-side closes positions at challenge
    // end and measures realised equity — a still-open winning position used
    // to be silently discarded (pass false-negative); a still-open losing
    // position used to be ignored too (pass false-positive). After this
    // force-close, state.equity reflects realised PnL of every position and
    // mtmEquity equals state.equity (no positions open).
    for (let i = state.openPositions.length - 1; i >= 0; i--) {
      const pos = state.openPositions[i]!;
      const cs = candlesByAsset[pos.sourceSymbol];
      let exitPrice: number | null = null;
      if (cs && cs.length > 0) {
        const matched = findCandleAtTime(cs, lastBar.openTime);
        if (matched) {
          exitPrice = matched.close;
        } else {
          // Fall back to most recent bar at-or-before lastBar.
          for (let j = cs.length - 1; j >= 0; j--) {
            if (cs[j]!.openTime <= lastBar.openTime) {
              exitPrice = cs[j]!.close;
              break;
            }
          }
        }
      }
      // Round 58 (Critical Fix #2): graceful fallback chain when no
      // candle is available for this asset on the final bar (feed
      // dropout, exchange halt). Previously we used pos.entryPrice
      // unconditionally → effPnl=0, silently booking a winning trade
      // as zero P&L and potentially flipping pass→fail. Order:
      //   1. lastKnownPrice (most recent close observed during MTM
      //      computation in any prior poll) — best estimate of where
      //      the position was at the time the feed died.
      //   2. entryPrice (zero-PnL) — last-resort, but we ALSO mark
      //      result.failReason="feed_lost" so the operator notices.
      // Prefer (1) when available; only fall through to (2) when the
      // feed has been dead since entry (lastKnownPrice never set).
      if (exitPrice == null) {
        if (pos.lastKnownPrice != null) {
          exitPrice = pos.lastKnownPrice;
        } else {
          exitPrice = pos.entryPrice;
          // Mark feed-lost so the pass-check below records the failure
          // mode explicitly. We only set this if the position has no
          // observed price at all (feed never emitted for this asset).
          // Don't clobber a result.failReason already set elsewhere.
          if (!result.failReason) {
            result.failReason = "feed_lost";
          }
        }
      }
      const { rawPnl, effPnl } = computeEffPnl(pos, exitPrice, cfg);
      state.equity *= 1 + effPnl;
      const closed: ClosedTradeV4 = {
        ticketId: pos.ticketId,
        symbol: pos.symbol,
        direction: pos.direction,
        entryTime: pos.entryTime,
        exitTime: lastBar.openTime,
        entryPrice: pos.entryPrice,
        exitPrice,
        rawPnl,
        effPnl,
        exitReason: "manual",
        day: state.day,
        entryDay: dayIndex(pos.entryTime, state.challengeStartTs),
      };
      state.closedTrades.push(closed);
      result.decision.closes.push({
        ticketId: pos.ticketId,
        exitPrice,
        exitReason: "manual",
      });
      if (cfg.kellySizing) {
        state.kellyPnls.push({ closeTime: lastBar.openTime, effPnl });
      }
    }
    state.openPositions = [];
    // After force-close: no unrealised PnL → MTM equals realised.
    state.mtmEquity = state.equity;
    // Round 57 V4-3 (Fix 2): trim inline so end-of-window force-close
    // pushes don't unbounded-grow the buffer.
    trimInline(state, cfg);

    // Time exhausted — evaluate pass on post-close equity (both predicates
    // identical now since no open positions remain, but kept symmetric for
    // parity with the mid-stream pass-check at Phase 84).
    const passed =
      state.equity >= 1 + cfg.profitTarget &&
      state.mtmEquity >= 1 + cfg.profitTarget &&
      state.tradingDays.length >= cfg.minTradingDays;
    state.stoppedReason = passed ? null : "time";
    result.challengeEnded = true;
    result.passed = passed;
    // Round 58 (Critical Fix #2): preserve "feed_lost" if the force-close
    // loop above could only fall back to entryPrice (no observed price
    // at all). That mode is operationally distinct from a clean time-out
    // — the operator should investigate the feed, not the strategy.
    if (!passed && result.failReason !== "feed_lost") {
      result.failReason = "time";
    }
    // Phase 59 (R44-V4-13): increment barsSeen + lastBarOpenTime so a
    // re-poll on the same bar is idempotent. Without this, a follow-up
    // tick re-ran day-rollover and could overwrite stoppedReason="time"
    // back to null when state.equity met the target post-end.
    state.barsSeen += 1;
    state.lastBarOpenTime = lastBar.openTime;
    return result;
  }

  // 3. Process exits FIRST (using current bar's HLC).
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i]!;
    const cs = candlesByAsset[pos.sourceSymbol];
    if (!cs) continue;
    // Phase 36 (R44-V4-6): pick the candle that matches lastBar.openTime,
    // not array-end. When the position's feed runs ahead of the reference
    // timeline, `cs[cs.length-1]` was a future bar — SL/TP could fire on
    // a bar that hadn't happened yet on the reference clock. Falls back
    // to the most recent bar at-or-before lastBar if exact match missing.
    let candle = findCandleAtTime(cs, lastBar.openTime);
    if (!candle) {
      // Closest bar ≤ lastBar.openTime (feed lagging → use last available).
      for (let j = cs.length - 1; j >= 0; j--) {
        if (cs[j]!.openTime <= lastBar.openTime) {
          candle = cs[j]!;
          break;
        }
      }
    }
    if (!candle) continue;
    let atrAtBar: number | null = null;
    if (cfg.chandelierExit) {
      const series =
        atrSeriesByAsset?.[pos!.sourceSymbol] ??
        atr(cs, cfg.chandelierExit.period);
      const v = series[series.length - 1];
      if (v != null) atrAtBar = v;
    }
    const assetCfg = cfg.assets.find((a) => a.symbol === pos!.symbol);
    const holdBars = assetCfg?.holdBars ?? cfg.holdBars;
    const exit = processPositionExit(
      pos,
      candle,
      barIdx,
      cfg,
      atrAtBar,
      holdBars,
    );
    if (exit) {
      const { rawPnl, effPnl } = computeEffPnl(pos, exit.exitPrice, cfg);
      void rawPnl;
      state.equity *= 1 + effPnl;
      const closed: ClosedTradeV4 = {
        ticketId: pos!.ticketId,
        symbol: pos!.symbol,
        direction: pos!.direction,
        entryTime: pos!.entryTime,
        exitTime: lastBar.openTime,
        entryPrice: pos!.entryPrice,
        exitPrice: exit.exitPrice,
        rawPnl,
        effPnl,
        exitReason: exit.reason,
        day: state.day,
        entryDay: dayIndex(pos!.entryTime, state.challengeStartTs),
      };
      state.closedTrades.push(closed);
      state.openPositions.splice(i, 1);
      result.decision.closes.push({
        ticketId: pos!.ticketId,
        exitPrice: exit.exitPrice,
        exitReason: exit.reason,
      });
      // Loss-streak tracking + Kelly buffer.
      const k = lsKey(pos!.symbol, pos!.direction);
      const ls = state.lossStreakByAssetDir[k] ?? {
        streak: 0,
        cdUntilBarsSeen: -1,
      };
      if (effPnl > 0) {
        ls.streak = 0;
        ls.reentryUntilBarsSeen = undefined;
      } else {
        ls.streak += 1;
        if (
          cfg.lossStreakCooldown &&
          ls.streak >= cfg.lossStreakCooldown.afterLosses
        ) {
          // Phase 36 (R44-V4-8): anchor cooldown on monotonic barsSeen
          // (not on `barIdx = refCandles.length-1` which can shift across
          // ticks when refKey changes).
          ls.cdUntilBarsSeen =
            state.barsSeen + cfg.lossStreakCooldown.cooldownBars;
        }
        // V5R reentryAfterStop: arm a re-entry slot when this loss was a
        // stop-out. Allows ONE next signal to bypass cooldown at sizeMult.
        if (cfg.reentryAfterStop && exit.reason === "stop") {
          ls.reentryUntilBarsSeen =
            state.barsSeen + cfg.reentryAfterStop.withinBars;
        }
      }
      state.lossStreakByAssetDir[k] = ls;
      if (cfg.kellySizing) {
        state.kellyPnls.push({ closeTime: lastBar.openTime, effPnl });
      }
    }
  }
  // Round 57 V4-3 (Fix 2): trim inline after the per-tick exit loop. With
  // long-running sessions (10000+ closed trades), the prior saveState-only
  // trim let kellyPnls grow unbounded — resolveSizingFactor's filter+slice
  // then ran O(N) per tick.
  trimInline(state, cfg);

  // 4. Recompute MTM equity after exits — uses CLOSE prices for unrealised.
  // Phase 36 (R44-V4-5): pick each asset's close at lastBar.openTime, not
  // array-end. With misaligned feeds, array-end could be a newer bar than
  // the reference, anchoring MTM peak too high.
  const closesBySource: Record<string, number> = {};
  for (const k of assetKeys) {
    const c = candlesByAsset[k]!;
    if (c.length === 0) continue;
    let chosen = findCandleAtTime(c, lastBar.openTime);
    if (!chosen) {
      for (let j = c!.length - 1; j >= 0; j--) {
        if (c![j]!.openTime <= lastBar.openTime) {
          chosen = c![j]!;
          break;
        }
      }
    }
    if (chosen) closesBySource[k] = chosen.close;
  }
  state.mtmEquity = computeMtmEquity(state, closesBySource, cfg);
  if (state.mtmEquity > state.dayPeak) state.dayPeak = state.mtmEquity;
  if (state.mtmEquity > state.challengePeak)
    state.challengePeak = state.mtmEquity;

  // V5R Round 60: Daily Equity Guardian — force-close ALL open positions
  // when MTM intraday equity drops below -triggerPct. This caps realised
  // loss before it can cascade to the 5% DL hard-stop. Distinct from
  // intradayDailyLossThrottle (which only blocks new entries).
  if (cfg.dailyEquityGuardian && state.openPositions.length > 0) {
    const mtmDayPnl = (state.mtmEquity - state.dayStart) / state.dayStart;
    if (mtmDayPnl <= -cfg.dailyEquityGuardian.triggerPct) {
      for (let i = state.openPositions.length - 1; i >= 0; i--) {
        const pos = state.openPositions[i]!;
        const exitPrice =
          closesBySource[pos.sourceSymbol] ??
          pos.lastKnownPrice ??
          pos.entryPrice;
        const { rawPnl, effPnl } = computeEffPnl(pos, exitPrice, cfg);
        state.equity *= 1 + effPnl;
        const closed: ClosedTradeV4 = {
          ticketId: pos.ticketId,
          symbol: pos.symbol,
          direction: pos.direction,
          entryTime: pos.entryTime,
          exitTime: lastBar.openTime,
          entryPrice: pos.entryPrice,
          exitPrice,
          rawPnl,
          effPnl,
          exitReason: "manual",
          day: state.day,
          entryDay: dayIndex(pos.entryTime, state.challengeStartTs),
        };
        state.closedTrades.push(closed);
        result.decision.closes.push({
          ticketId: pos.ticketId,
          exitPrice,
          exitReason: "manual",
        });
        if (cfg.kellySizing) {
          state.kellyPnls.push({ closeTime: lastBar.openTime, effPnl });
        }
      }
      state.openPositions = [];
      state.mtmEquity = state.equity;
      result.notes.push(
        `dailyEquityGuardian fired: dayPnl=${(mtmDayPnl * 100).toFixed(2)}% — closed all positions`,
      );
    }
  }

  // 5. Fail-checks (realised equity — FTMO measures realised).
  if (state.equity <= 1 - cfg.maxTotalLoss + 1e-9) {
    state.stoppedReason = "total_loss";
    result.challengeEnded = true;
    result.failReason = "total_loss";
    state.barsSeen += 1;
    state.lastBarOpenTime = lastBar.openTime;
    return result;
  }
  if (
    (state.equity - state.dayStart) / state.dayStart <=
    -cfg.maxDailyLoss + 1e-9
  ) {
    state.stoppedReason = "daily_loss";
    result.challengeEnded = true;
    result.failReason = "daily_loss";
    state.barsSeen += 1;
    state.lastBarOpenTime = lastBar.openTime;
    return result;
  }

  // 6. Target-hit handling.
  // Round 54 (R54-V4-2): require BOTH realised AND mtm equity ≥ target.
  // Previously only realised was checked here, but the matching pass-check
  // (Phase 84 below) requires both. With realised-only setting
  // firstTargetHitDay, a window-exhaust path that only inspects
  // `firstTargetHitDay !== null` (see end-of-window block in `simulate()`)
  // could declare pass even when MTM never recovered above target after a
  // losing open position dragged equity back down. Aligning the predicate
  // here closes that false-positive-pass landmine.
  if (
    state.firstTargetHitDay === null &&
    state.equity >= 1 + cfg.profitTarget &&
    state.mtmEquity >= 1 + cfg.profitTarget
  ) {
    state.firstTargetHitDay = state.day;
    state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    result.targetHit = true;
  }
  // After target hit, EVERY subsequent calendar day counts as a trading-day
  // (the bot pings the broker daily to satisfy minTradingDays). Mirrors
  // engine's finishPausedPass() — a real-world bot places a tiny no-risk
  // trade once per day until minTradingDays is satisfied.
  //
  // Round 57 V4-3 (Fix 5): use dayIndex(lastBar.openTime, ...) for ping-day
  // book-keeping, mirroring the entry-side rule (R56 fix at line 1591).
  // state.day and dayIndex(lastBar.openTime, ...) are equivalent at this
  // point on the same tick, but the explicit derivation makes the
  // "trading-day = challenge-day attributed via challengeStartTs" rule
  // consistent across both ping and entry paths — defensive against any
  // future reorder of state.day mutation relative to this push.
  if (state.pausedAtTarget && state.firstTargetHitDay !== null) {
    const pingDay = dayIndex(lastBar.openTime, state.challengeStartTs);
    if (!state.tradingDays.includes(pingDay)) {
      state.tradingDays.push(pingDay);
    }
  }
  // Phase 84 (R51-FTMO-1): require BOTH realised AND mark-to-market equity
  // ≥ profitTarget before declaring pass. With only realised checked, a
  // config sitting on +9% realised + −4% MTM unrealised would pass mid-
  // stream even though the open position will close at a loss and drop
  // the account below target. FTMO server-side measures end-of-day —
  // mtmEquity is the better proxy for "would FTMO declare pass right now?"
  if (
    state.equity >= 1 + cfg.profitTarget &&
    state.mtmEquity >= 1 + cfg.profitTarget &&
    state.tradingDays.length >= cfg.minTradingDays
  ) {
    state.stoppedReason = null;
    result.challengeEnded = true;
    result.passed = true;
    state.barsSeen += 1;
    state.lastBarOpenTime = lastBar.openTime;
    return result;
  }

  // 7. Entry-side filters.
  let entriesAllowed = !state.pausedAtTarget;
  if (entriesAllowed && cfg.dailyPeakTrailingStop) {
    const drop =
      (state.dayPeak - state.mtmEquity) / Math.max(state.dayPeak, 1e-9);
    if (drop >= cfg.dailyPeakTrailingStop.trailDistance) {
      entriesAllowed = false;
      result.notes.push(
        `dailyPeakTrailingStop: drop ${(drop * 100).toFixed(2)}% >= ${(
          cfg.dailyPeakTrailingStop.trailDistance * 100
        ).toFixed(2)}%`,
      );
    }
  }
  if (entriesAllowed && cfg.challengePeakTrailingStop) {
    const drop =
      (state.challengePeak - state.mtmEquity) /
      Math.max(state.challengePeak, 1e-9);
    if (drop >= cfg.challengePeakTrailingStop.trailDistance) {
      entriesAllowed = false;
      result.notes.push(
        `challengePeakTrailingStop: drop ${(drop * 100).toFixed(2)}%`,
      );
    }
  }
  if (entriesAllowed && cfg.intradayDailyLossThrottle) {
    const dayPnl = (state.equity - state.dayStart) / state.dayStart;
    if (dayPnl <= -cfg.intradayDailyLossThrottle.hardLossThreshold) {
      entriesAllowed = false;
      result.notes.push(
        `intradayDailyLossThrottle hard: ${(dayPnl * 100).toFixed(2)}%`,
      );
    }
  }
  if (entriesAllowed && cfg.maxConcurrentTrades !== undefined) {
    if (state.openPositions.length >= cfg.maxConcurrentTrades) {
      entriesAllowed = false;
      result.notes.push(`MCT cap reached: ${state.openPositions.length}`);
    }
  }

  // 8. Detect signals on each asset (delegates to engine's detectAsset).
  if (entriesAllowed) {
    const crossKey = cfg.crossAssetFilter?.symbol;
    const crossCandles = crossKey ? candlesByAsset[crossKey] : undefined;
    const extra: Record<string, Candle[]> = {};
    if (cfg.crossAssetFiltersExtra) {
      for (const f of cfg.crossAssetFiltersExtra) {
        const ec = candlesByAsset[f.symbol];
        if (ec) extra[f.symbol] = ec;
      }
    }

    for (const asset of cfg.assets) {
      // Per-asset gates.
      if (
        asset.activateAfterDay !== undefined &&
        state.day < asset.activateAfterDay
      ) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `activateAfterDay ${asset.activateAfterDay} > day ${state.day}`,
        });
        continue;
      }
      if (
        asset.deactivateAfterDay !== undefined &&
        state.day >= asset.deactivateAfterDay
      ) {
        result.skipped.push({
          asset: asset.symbol,
          reason: "deactivateAfterDay",
        });
        continue;
      }
      if (
        asset.minEquityGain !== undefined &&
        state.equity - 1 < asset.minEquityGain
      ) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `minEquityGain ${asset.minEquityGain} not met`,
        });
        continue;
      }
      if (
        asset.maxEquityGain !== undefined &&
        state.equity - 1 > asset.maxEquityGain
      ) {
        result.skipped.push({
          asset: asset.symbol,
          reason: "maxEquityGain exceeded",
        });
        continue;
      }

      // correlationFilter: count same-direction open positions.
      // We don't know direction yet — apply AFTER detection.

      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const candles = candlesByAsset[sourceKey];
      if (!candles || candles.length < 100) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `insufficient candles (${candles?.length ?? 0})`,
        });
        continue;
      }
      // detectAsset accepts a slice — we pass the whole array (live convention).
      let trades: Daytrade24hTrade[];
      try {
        trades = detectAsset(candles, asset, cfg, crossCandles, extra);
      } catch (err) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `detectAsset error: ${(err as Error).message}`,
        });
        continue;
      }
      // Round 54 (R54-V4-4): collect ALL trades whose entryTime equals
      // current bar's openTime, not just the first one. detectAsset can
      // emit multiple signals on the same bar (e.g. long + short on
      // different strategy branches, or two parallel pullback fills). The
      // backtest engine sees all of them; the live engine previously saw
      // only the first via `.find()` → silent drift on multi-signal bars.
      // Each matched signal flows through the full per-signal entry
      // sequence (LSC / correlation / MCT recheck / sizing / stop caps) so
      // a previously-opened position in this same bar will correctly bump
      // the openPositions count for subsequent matches.
      // V5R meanReversionSource: emit parallel MR signals on RSI extremes.
      // Engine handles exits same as trend signals.
      const mrTrades: Array<(typeof trades)[number] & { _isMR?: true }> = [];
      if (
        cfg.meanReversionSource &&
        candles.length > cfg.meanReversionSource.period + 2
      ) {
        const mr = cfg.meanReversionSource;
        const rsiSeries = rsi(
          candles.map((c) => c.close),
          mr.period,
        );
        const lastRsi = rsiSeries[rsiSeries.length - 1];
        const prevRsi = rsiSeries[rsiSeries.length - 2];
        if (lastRsi != null && prevRsi != null) {
          const longCross = prevRsi >= mr.oversold && lastRsi < mr.oversold;
          const shortCross =
            prevRsi <= mr.overbought && lastRsi > mr.overbought;
          if (longCross || shortCross) {
            const dir: "long" | "short" = longCross ? "long" : "short";
            // Cooldown check vs trend lossStreakByAssetDir is separate —
            // use a simple "last MR entryTime per asset|dir" via state extras.
            const mrKey = `MR|${asset.symbol}|${dir}`;
            const lastMrTime =
              (state as { _mrLast?: Record<string, number> })._mrLast?.[
                mrKey
              ] ?? 0;
            const cooldownMs =
              mr.cooldownBars *
              (lastBar.openTime -
                (candles[candles.length - 2]?.openTime ??
                  lastBar.openTime - 1800000));
            if (lastBar.openTime - lastMrTime >= cooldownMs) {
              mrTrades.push({
                symbol: asset.symbol,
                direction: dir,
                entryTime: lastBar.openTime,
                exitTime: lastBar.openTime,
                entryPrice: lastBar.close,
                exitPrice: lastBar.close,
                rawPnl: 0,
                effPnl: 0,
                day: state.day,
                entryDay: state.day,
                exitReason: "time",
                holdHours: 0,
                volMult: mr.sizeMult,
                _isMR: true,
              });
              if (!(state as { _mrLast?: Record<string, number> })._mrLast) {
                (state as { _mrLast?: Record<string, number> })._mrLast = {};
              }
              (state as { _mrLast?: Record<string, number> })._mrLast![mrKey] =
                lastBar.openTime;
            }
          }
        }
      }
      const matchedAll = [
        ...trades.filter((t) => t.entryTime === lastBar.openTime),
        ...mrTrades,
      ];
      if (matchedAll.length === 0) continue;

      let mctBreakOuter = false;
      for (const matched of matchedAll) {
        // Loss-streak cooldown (per asset|direction).
        const k = lsKey(asset.symbol, matched.direction);
        const ls = state.lossStreakByAssetDir[k];
        // V5R reentryAfterStop: if a re-entry slot is armed and not expired,
        // bypass the cooldown gate. Slot is consumed downstream by clearing
        // reentryUntilBarsSeen after sizing.
        const reentryArmed =
          cfg.reentryAfterStop &&
          ls?.reentryUntilBarsSeen !== undefined &&
          state.barsSeen <= ls.reentryUntilBarsSeen;
        if (ls && state.barsSeen < ls.cdUntilBarsSeen && !reentryArmed) {
          result.skipped.push({
            asset: asset.symbol,
            reason: `lossStreakCooldown until barsSeen=${ls.cdUntilBarsSeen}`,
          });
          continue;
        }

        // correlationFilter check — count open same-direction.
        if (cfg.correlationFilter) {
          const sameDir = state.openPositions.filter(
            (p) => p.direction === matched.direction,
          ).length;
          if (sameDir >= cfg.correlationFilter.maxOpenSameDirection) {
            result.skipped.push({
              asset: asset.symbol,
              reason: `correlationFilter ${sameDir} same-dir open`,
            });
            continue;
          }
        }

        // Final MCT re-check (could've opened in same bar). When MCT is
        // hit we break the OUTER asset loop too — no further entries
        // possible this bar.
        if (
          cfg.maxConcurrentTrades !== undefined &&
          state.openPositions.length >= cfg.maxConcurrentTrades
        ) {
          result.skipped.push({
            asset: asset.symbol,
            reason: "MCT cap mid-bar",
          });
          mctBreakOuter = true;
          break;
        }

        // Sizing: derive effRisk same way as backtest equity loop.
        const factor = resolveSizingFactor(state, cfg, lastBar.openTime);
        // Phase 30 (V4 Audit Bug 6): compute final stopPct (incl. atrStop)
        // BEFORE effRisk back-derive. Was: back-derive used base stopPct,
        // then atrStop pushed stopPct higher → modelled loss exceeded
        // LIVE_LOSS_CAP for atrStop-heavy configs (V5_QUARTZ family).
        const tpPct = asset.tpPct ?? cfg.tpPct;
        let stopPct = asset.stopPct ?? cfg.stopPct;
        if (cfg.atrStop) {
          // Round 54 (R54-V4-6): anchor ATR on prev-bar (length-2), not
          // current-bar (length-1). The series is computed from
          // `candles.slice(0, i+1)` where `i` is the just-closed bar;
          // length-1 includes the entry-bar's high/low/close which is a
          // subtle look-ahead. Backtest engine resolves stop via the
          // signal-bar's ATR (computed on bars up-to and INCLUDING the
          // signal bar) — same convention. Falls back to length-1 only if
          // the prev-bar ATR is null (warm-up window).
          const series = atr(candles, cfg.atrStop.period);
          const prev =
            series.length >= 2 ? series[series.length - 2] : undefined;
          const cur = series[series.length - 1];
          const v = prev ?? cur;
          if (v != null) {
            const atrFrac = (cfg.atrStop.stopMult * v) / matched.entryPrice;
            stopPct = Math.max(stopPct, atrFrac);
          }
        }
        if (cfg.liveCaps && stopPct > cfg.liveCaps.maxStopPct) {
          result.skipped.push({
            asset: asset.symbol,
            reason: `stopPct ${(stopPct * 100).toFixed(2)}% > maxStopPct ${(
              cfg.liveCaps.maxStopPct * 100
            ).toFixed(2)}%`,
          });
          continue;
        }

        // V5R bypassLiveCaps: skip volMult ceiling, maxRiskFrac cap, and
        // DL-derived back-cap. Trust the strategy's day-progressive factor.
        const useCaps = cfg.liveCaps && !cfg.bypassLiveCaps;
        const volMult = useCaps
          ? Math.min(matched.volMult ?? 1.0, 1.0)
          : (matched.volMult ?? 1.0);
        // V5R day-progressive sizing — multiply riskFrac by per-day factor.
        let dayProgressiveFactor = 1.0;
        if (cfg.dayProgressiveSizing && cfg.dayProgressiveSizing.length > 0) {
          const sorted = [...cfg.dayProgressiveSizing].sort(
            (a, b) => b.dayAtLeast - a.dayAtLeast,
          );
          for (const tier of sorted) {
            if (state.day >= tier.dayAtLeast) {
              dayProgressiveFactor = tier.factor;
              break;
            }
          }
        }
        // V5R reentryAfterStop: apply sizeMult and consume the slot.
        let reentrySizeMult = 1.0;
        if (reentryArmed && ls && cfg.reentryAfterStop) {
          reentrySizeMult = cfg.reentryAfterStop.sizeMult;
          ls.reentryUntilBarsSeen = undefined;
        }
        let effRisk =
          asset.riskFrac *
          factor *
          volMult *
          dayProgressiveFactor *
          reentrySizeMult;
        if (useCaps && effRisk > cfg.liveCaps!.maxRiskFrac) {
          effRisk = cfg.liveCaps!.maxRiskFrac;
        }
        // Phase 59 (R44-V4-10): derive the live-loss cap from cfg.maxDailyLoss
        // (×0.8 safety margin) instead of hardcoding 0.04. A 0.10-DL config
        // was needlessly restricted to 4% per trade; a 0.03-DL config was
        // not restrictive enough. Back-derive effRisk from this cap using
        // the FINAL stopPct.
        if (useCaps) {
          const LIVE_LOSS_CAP = (cfg.maxDailyLoss ?? 0.05) * 0.8;
          if (stopPct > 0 && cfg.leverage > 0) {
            const modelledLoss = effRisk * stopPct * cfg.leverage;
            if (modelledLoss > LIVE_LOSS_CAP) {
              effRisk = LIVE_LOSS_CAP / (stopPct * cfg.leverage);
            }
          }
        }
        if (effRisk <= 0) continue;

        const stopPrice =
          matched.direction === "long"
            ? matched.entryPrice * (1 - stopPct)
            : matched.entryPrice * (1 + stopPct);
        const tpPrice =
          matched.direction === "long"
            ? matched.entryPrice * (1 + tpPct)
            : matched.entryPrice * (1 - tpPct);

        let chandelierAtrAtEntry: number | null = null;
        if (cfg.chandelierExit) {
          const series = atr(candles, cfg.chandelierExit.period);
          const v = series[series.length - 1];
          if (v != null) chandelierAtrAtEntry = v;
        }

        // Ticket id includes direction so two signals (long+short) on the
        // same bar produce distinct ids.
        const ticketId = `${asset.symbol}@${matched.entryTime}@${matched.direction}`;
        const newPos: OpenPositionV4 = {
          ticketId,
          symbol: asset.symbol,
          sourceSymbol: sourceKey,
          direction: matched.direction,
          entryTime: matched.entryTime,
          entryPrice: matched.entryPrice,
          initialStopPct: stopPct,
          stopPrice,
          tpPrice,
          effRisk,
          // Round 54 (R54-V4-1): monotonic anchor — was `barIdx` (=
          // refCandles.length-1) which is non-monotonic when refKey shifts.
          entryBarIdx: state.barsSeen,
          highWatermark: matched.entryPrice,
          beActive: false,
          ptpTriggered: false,
          ptpRealizedPct: 0,
          ptpLevelIdx: 0,
          ptpLevelsRealized: 0,
        };
        state.openPositions.push(newPos);
        // BUGFIX 2026-05-03 (R56 audit Fix 4): use entryDay derived from the
        // matched signal's entryTime — NOT state.day. They are identical at
        // the bar that fires entry (entryTime === lastBar.openTime), but
        // computing from entryTime makes the "FTMO trading-day = day with an
        // executed ENTRY" rule explicit. Mirrors sequential engine line 5347
        // (`tradingDays.add(t.entryDay)`).
        const entryDay = dayIndex(matched.entryTime, state.challengeStartTs);
        if (!state.tradingDays.includes(entryDay)) {
          state.tradingDays.push(entryDay);
        }

        result.decision.opens.push({
          symbol: asset.symbol,
          sourceSymbol: sourceKey,
          direction: matched.direction,
          entryTime: matched.entryTime,
          entryPrice: matched.entryPrice,
          stopPrice,
          tpPrice,
          stopPct,
          tpPct,
          effRisk,
          ...(chandelierAtrAtEntry !== null ? { chandelierAtrAtEntry } : {}),
          ...(cfg.partialTakeProfit
            ? { ptpConfig: cfg.partialTakeProfit }
            : {}),
          ...(cfg.breakEven ? { beThreshold: cfg.breakEven.threshold } : {}),
        });
      }
      if (mctBreakOuter) break;
    }
  }

  state.barsSeen += 1;
  state.lastBarOpenTime = lastBar.openTime;
  return result;
}

// ─── Backtest harness — used by parity tests + V4-Sim equivalence ──────

export interface SimulateResult {
  passed: boolean;
  // Phase 29: "give_back" added — target hit mid-stream but final equity
  // gave back > 50% of profit by end-of-window.
  reason: "profit_target" | "daily_loss" | "total_loss" | "time" | "give_back";
  passDay?: number;
  finalEquityPct: number;
  trades: ClosedTradeV4[];
  state: FtmoLiveStateV4;
}

/**
 * Drive a complete challenge by polling pollLive() bar-by-bar across the
 * window. Used for parity tests vs. V4-simulator and for backtests.
 *
 * Round 57 (R57-V4-3) NOTE: simulate() assumes an UNINTERRUPTED candle
 * stream — caller feeds every bar from startBar to endBar in order. The
 * production live path (`tools/ftmo_executor.py`) does NOT replay missed
 * bars: when the executor restarts after a crash/reboot, instead of
 * iterating engine state through the off-period (impossible without an
 * archived candle buffer), it reconciles open positions against
 * `mt5.positions_get()` + `mt5.history_deals_get()` via
 * `reconcile_missing_positions()`. Any position no longer on MT5 was
 * closed during the off-period; the actual exit is read from broker
 * history and persisted to `closed-during-offline.json` for the next V4
 * state-load to ingest. This is the "Option B" path documented in the
 * R57 audit — live truth comes from MT5 history, not engine replay.
 *
 * @param alignedCandles  per-asset Candle[] arrays, all same length, same
 *                        openTime sequence (caller aligns).
 * @param cfg             FTMO config.
 * @param startBar        index in `alignedCandles[any]` where challenge starts.
 * @param endBar          exclusive end bar index.
 */
export function simulate(
  alignedCandles: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  startBar: number,
  endBar: number,
  cfgLabel = "sim",
): SimulateResult {
  const state = initialState(cfgLabel);

  // Precompute ATR series for chandelier (perf — avoids re-computing each tick).
  const atrSeriesByAsset: Record<string, (number | null)[]> = {};
  if (cfg.chandelierExit) {
    for (const asset of cfg.assets) {
      const sourceKey = asset.sourceSymbol ?? asset.symbol;
      const cs = alignedCandles[sourceKey];
      if (cs) atrSeriesByAsset[sourceKey] = atr(cs, cfg.chandelierExit.period);
    }
  }

  for (let i = startBar; i < endBar; i++) {
    if (state.stoppedReason) break;
    // Build per-tick candle slices ending at index i (live polling convention).
    const sliceByAsset: Record<string, Candle[]> = {};
    for (const k of Object.keys(alignedCandles)) {
      sliceByAsset[k] = alignedCandles[k]!.slice(0, i + 1);
    }
    // Build sliced ATR series (must align with sliced candles — same length).
    const slicedAtr: Record<string, (number | null)[]> = {};
    if (cfg.chandelierExit) {
      for (const k of Object.keys(atrSeriesByAsset)) {
        slicedAtr[k] = atrSeriesByAsset[k]!.slice(0, i + 1);
      }
    }
    const r = pollLive(state, sliceByAsset, cfg, slicedAtr);
    if (r.challengeEnded) {
      if (r.passed) {
        return {
          passed: true,
          reason: "profit_target",
          passDay: Math.max(
            (state.firstTargetHitDay ?? state.day) + 1,
            cfg.minTradingDays,
          ),
          finalEquityPct: state.equity - 1,
          trades: state.closedTrades,
          state,
        };
      }
      return {
        passed: false,
        // Round 58: feed_lost is a live-only failure mode; SimulateResult
        // doesn't model it (the simulator always has full candle history),
        // so we collapse it to "time" for backtest-equivalence reporting.
        reason:
          r.failReason && r.failReason !== "feed_lost" ? r.failReason : "time",
        finalEquityPct: state.equity - 1,
        trades: state.closedTrades,
        state,
      };
    }
  }

  // Window exhausted — end-of-time check. FTMO rule: if target was hit at
  // any point AND minTradingDays satisfied, the challenge passed (subsequent
  // give-back doesn't void the pass, as long as DL/TL didn't trip).
  //
  // Phase 29 (V4 Engine Bug 15): also check final MTM equity. If a
  // catastrophic open-position-stop drove state.equity well below target
  // AFTER the engine recorded firstTargetHitDay but BEFORE DL/TL fail-checks
  // could trip, the engine would still report `passed: true`. The DL/TL
  // checks already handle the proper-fail cases mid-stream — this is just a
  // belt-and-suspenders sanity check at window-exhaust. Threshold:
  // finalEquity must be at least (1 + 0.5×profitTarget). Below that we
  // demote to a 'partial' fail with an explanatory reason.
  const targetHit =
    state.firstTargetHitDay !== null &&
    state.tradingDays.length >= cfg.minTradingDays;
  const finalEquityFloor = 1 + cfg.profitTarget * 0.5;
  const giveBackTooFar =
    targetHit &&
    Number.isFinite(state.equity) &&
    state.equity < finalEquityFloor;
  const passed = targetHit && !giveBackTooFar;
  return {
    passed,
    reason: passed ? "profit_target" : giveBackTooFar ? "give_back" : "time",
    passDay: passed
      ? Math.max((state.firstTargetHitDay ?? state.day) + 1, cfg.minTradingDays)
      : undefined,
    finalEquityPct: state.equity - 1,
    trades: state.closedTrades,
    state,
  };
}

// ─── Export the asset cfg type the V4 caller will reference ────────────
export type { Daytrade24hAssetCfg };
