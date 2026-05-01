/**
 * FTMO V4 LIVE ENGINE — persistent-state bar-by-bar live engine.
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
import { atr } from "@/utils/indicators";
import type { Candle } from "@/utils/indicators";
import {
  detectAsset,
  type Daytrade24hAssetCfg,
  type Daytrade24hTrade,
  type FtmoDaytrade24hConfig,
} from "@/utils/ftmoDaytrade24h";

// ─── Types ──────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1 as const;

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
  entryBarIdx: number;
  highWatermark: number; // long: highest high since entry; short: lowest low
  beActive: boolean;
  ptpTriggered: boolean;
  ptpRealizedPct: number;
  /** Multi-level PTP — index of next level to fire. */
  ptpLevelIdx: number;
  ptpLevelsRealized: number;
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
   * cdUntilBarIdx is the relative bar index after which entries unblock.
   */
  lossStreakByAssetDir: Record<
    string,
    { streak: number; cdUntilBarIdx: number }
  >;
  /** Kelly window: realised pnl-per-trade with closeTime for filter-by-entryTime. */
  kellyPnls: Array<{ closeTime: number; effPnl: number }>;
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
  failReason: "total_loss" | "daily_loss" | "time" | null;
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

const STATE_FILENAME = "v4-engine.json";

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
      const parsed = JSON.parse(raw) as Partial<FtmoLiveStateV4>;
      // Phase 14 (V4 Bug 9): on schema/cfg mismatch, BACK UP the old state
      // file before discarding. Without this, deploying a new version or
      // changing FTMO_TF wiped the entire challenge state silently — losing
      // peakDrawdown, pause state, ping-day records, kelly window, etc.
      if (
        parsed.schemaVersion !== SCHEMA_VERSION ||
        parsed.cfgLabel !== cfgLabel
      ) {
        const backupPath = `${filePath}.backup.${Date.now()}`;
        try {
          fs.renameSync(filePath, backupPath);
        } catch {
          /* ignore — fresh state will overwrite anyway */
        }
        console.error(
          `[V4] STATE MISMATCH — backed up to ${backupPath}. ` +
            `Old: ${parsed.cfgLabel}/${parsed.schemaVersion}, ` +
            `New: ${cfgLabel}/${SCHEMA_VERSION}`,
        );
        return initialState(cfgLabel);
      }
      return parsed as FtmoLiveStateV4;
    } catch (_err) {
      if (attempt === 0) continue; // retry once on transient parse error
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
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function dayIndex(barTs: number, challengeStart: number): number {
  if (challengeStart <= 0) return 0;
  // Phase 14 (V4 Bug 5): align day-rollover with FTMO Prague-midnight, not
  // UTC midnight. Python executor uses ZoneInfo("Europe/Prague") for
  // dayPeak; engine was using UTC → 1-2h disagreement per day → DL/TL
  // checks attribute trades to the wrong day around CET 23:00-00:00.
  const offset = pragueOffsetMs(barTs);
  return Math.floor((barTs + offset - challengeStart) / (24 * 3600 * 1000));
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
 */
function resolveSizingFactor(
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
      for (const tier of sortedTiers) {
        if (wr >= tier.winRateAbove) {
          factor *= tier.multiplier;
          break;
        }
      }
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
  if (cfg.intradayDailyLossThrottle) {
    const dayPnl = (state.equity - state.dayStart) / state.dayStart;
    if (dayPnl <= -cfg.intradayDailyLossThrottle.softLossThreshold) {
      factor *= cfg.intradayDailyLossThrottle.softFactor;
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
          ? pos.entryPrice * (1 + lvl.triggerPct)
          : pos.entryPrice * (1 - lvl.triggerPct);
      const lvlHit =
        pos.direction === "long"
          ? candle.high >= triggerPrice
          : candle.low <= triggerPrice;
      if (!lvlHit) break;
      pos.ptpLevelsRealized += lvl.closeFraction * lvl.triggerPct;
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
  if (pos.direction === "long") {
    if (candle.low <= pos.stopPrice) {
      return { exitPrice: pos.stopPrice, reason: "stop" };
    }
    if (candle.high >= pos.tpPrice) {
      return { exitPrice: pos.tpPrice, reason: "tp" };
    }
  } else {
    if (candle.high >= pos.stopPrice) {
      return { exitPrice: pos.stopPrice, reason: "stop" };
    }
    if (candle.low <= pos.tpPrice) {
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
    return arr[arr.length - 1].openTime;
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
        candlesByAsset[k][candlesByAsset[k].length - 1].openTime === minLastBar,
    ) ?? assetKeys[0];
  const refCandles = candlesByAsset[refKey];
  const lastBar = refCandles[refCandles.length - 1];
  const barIdx = refCandles.length - 1;

  // First-call: anchor challenge start.
  if (state.challengeStartTs === 0) {
    state.challengeStartTs = lastBar.openTime;
    state.lastBarOpenTime = lastBar.openTime;
    state.dayStart = state.equity;
    state.dayPeak = state.mtmEquity;
    state.challengePeak = state.mtmEquity;
  }

  // 1. Idempotent retry guard.
  if (lastBar.openTime <= state.lastBarOpenTime && state.barsSeen > 0) {
    result.notes.push("bar already processed (idempotent no-op)");
    return result;
  }

  // 2. Day-rollover.
  const newDay = dayIndex(lastBar.openTime, state.challengeStartTs);
  if (newDay > state.day) {
    state.day = newDay;
    state.dayStart = state.equity;
    state.dayPeak = state.mtmEquity; // reset to current MTM
  }
  if (newDay >= cfg.maxDays) {
    // Time exhausted.
    const passed =
      state.equity >= 1 + cfg.profitTarget &&
      state.tradingDays.length >= cfg.minTradingDays;
    state.stoppedReason = passed ? null : "time";
    result.challengeEnded = true;
    result.passed = passed;
    if (!passed) result.failReason = "time";
    return result;
  }

  // 3. Process exits FIRST (using current bar's HLC).
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    const cs = candlesByAsset[pos.sourceSymbol];
    if (!cs) continue;
    const candle = cs[cs.length - 1];
    if (!candle) continue;
    let atrAtBar: number | null = null;
    if (cfg.chandelierExit) {
      const series =
        atrSeriesByAsset?.[pos.sourceSymbol] ??
        atr(cs, cfg.chandelierExit.period);
      const v = series[series.length - 1];
      if (v != null) atrAtBar = v;
    }
    const assetCfg = cfg.assets.find((a) => a.symbol === pos.symbol);
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
        ticketId: pos.ticketId,
        symbol: pos.symbol,
        direction: pos.direction,
        entryTime: pos.entryTime,
        exitTime: lastBar.openTime,
        entryPrice: pos.entryPrice,
        exitPrice: exit.exitPrice,
        rawPnl,
        effPnl,
        exitReason: exit.reason,
        day: state.day,
        entryDay: dayIndex(pos.entryTime, state.challengeStartTs),
      };
      state.closedTrades.push(closed);
      state.openPositions.splice(i, 1);
      result.decision.closes.push({
        ticketId: pos.ticketId,
        exitPrice: exit.exitPrice,
        exitReason: exit.reason,
      });
      // Loss-streak tracking + Kelly buffer.
      const k = lsKey(pos.symbol, pos.direction);
      const ls = state.lossStreakByAssetDir[k] ?? {
        streak: 0,
        cdUntilBarIdx: -1,
      };
      if (effPnl > 0) {
        ls.streak = 0;
      } else {
        ls.streak += 1;
        if (
          cfg.lossStreakCooldown &&
          ls.streak >= cfg.lossStreakCooldown.afterLosses
        ) {
          ls.cdUntilBarIdx = barIdx + cfg.lossStreakCooldown.cooldownBars;
        }
      }
      state.lossStreakByAssetDir[k] = ls;
      if (cfg.kellySizing) {
        state.kellyPnls.push({ closeTime: lastBar.openTime, effPnl });
      }
    }
  }

  // 4. Recompute MTM equity after exits — uses CLOSE prices for unrealised.
  const closesBySource: Record<string, number> = {};
  for (const k of assetKeys) {
    const c = candlesByAsset[k];
    if (c.length > 0) closesBySource[k] = c[c.length - 1].close;
  }
  state.mtmEquity = computeMtmEquity(state, closesBySource, cfg);
  if (state.mtmEquity > state.dayPeak) state.dayPeak = state.mtmEquity;
  if (state.mtmEquity > state.challengePeak)
    state.challengePeak = state.mtmEquity;

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
  if (
    state.firstTargetHitDay === null &&
    state.equity >= 1 + cfg.profitTarget
  ) {
    state.firstTargetHitDay = state.day;
    state.pausedAtTarget = !!cfg.pauseAtTargetReached;
    result.targetHit = true;
  }
  // After target hit, EVERY subsequent calendar day counts as a trading-day
  // (the bot pings the broker daily to satisfy minTradingDays). Mirrors
  // engine's finishPausedPass() — a real-world bot places a tiny no-risk
  // trade once per day until minTradingDays is satisfied.
  if (state.pausedAtTarget && state.firstTargetHitDay !== null) {
    if (!state.tradingDays.includes(state.day)) {
      state.tradingDays.push(state.day);
    }
  }
  if (
    state.equity >= 1 + cfg.profitTarget &&
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
      let trades: Daytrade24hTrade[] = [];
      try {
        trades = detectAsset(candles, asset, cfg, crossCandles, extra);
      } catch (err) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `detectAsset error: ${(err as Error).message}`,
        });
        continue;
      }
      // Find trade whose entryTime equals current bar's openTime (live-poll
      // convention — detectAsset enters on next bar of signal-bar; signal at
      // candles[N-1] enters on candles[N].open == lastBar.openTime).
      const matched = trades.find((t) => t.entryTime === lastBar.openTime);
      if (!matched) continue;

      // Loss-streak cooldown (per asset|direction).
      const k = lsKey(asset.symbol, matched.direction);
      const ls = state.lossStreakByAssetDir[k];
      if (ls && barIdx < ls.cdUntilBarIdx) {
        result.skipped.push({
          asset: asset.symbol,
          reason: `lossStreakCooldown until bar ${ls.cdUntilBarIdx}`,
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

      // Final MCT re-check (could've opened in same bar).
      if (
        cfg.maxConcurrentTrades !== undefined &&
        state.openPositions.length >= cfg.maxConcurrentTrades
      ) {
        result.skipped.push({ asset: asset.symbol, reason: "MCT cap mid-bar" });
        break;
      }

      // Sizing: derive effRisk same way as backtest equity loop.
      const factor = resolveSizingFactor(state, cfg, lastBar.openTime);
      const volMult = cfg.liveCaps
        ? Math.min(matched.volMult ?? 1.0, 1.0)
        : (matched.volMult ?? 1.0);
      let effRisk = asset.riskFrac * factor * volMult;
      if (cfg.liveCaps && effRisk > cfg.liveCaps.maxRiskFrac) {
        effRisk = cfg.liveCaps.maxRiskFrac;
      }
      // Phase 15 (V4 Bug 7): back-derive effRisk from the live equity-loss
      // cap so MTM accounting stays aligned with what the broker actually
      // deploys. Without this, engine effRisk=0.4 × stopPct=5% × lev=10 =
      // 20% modelled loss/trade, but Python wrapper clamps the deployed
      // size to 4% live-cap → MTM diverges by 5× per trade.
      const LIVE_LOSS_CAP = 0.04;
      // Use this asset's stop+leverage to find the equivalent effRisk that
      // would produce LIVE_LOSS_CAP equity-loss at stop-out.
      const stopPctForCalc = asset.stopPct ?? cfg.stopPct;
      if (stopPctForCalc > 0 && cfg.leverage > 0) {
        const modelledLoss = effRisk * stopPctForCalc * cfg.leverage;
        if (modelledLoss > LIVE_LOSS_CAP) {
          effRisk = LIVE_LOSS_CAP / (stopPctForCalc * cfg.leverage);
        }
      }
      if (effRisk <= 0) continue;

      // Stop/TP — recompute from entryPrice + asset overrides + atrStop.
      const tpPct = asset.tpPct ?? cfg.tpPct;
      let stopPct = asset.stopPct ?? cfg.stopPct;
      if (cfg.atrStop) {
        const series = atr(candles, cfg.atrStop.period);
        const v = series[series.length - 1];
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

      const ticketId = `${asset.symbol}@${matched.entryTime}`;
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
        entryBarIdx: barIdx,
        highWatermark: matched.entryPrice,
        beActive: false,
        ptpTriggered: false,
        ptpRealizedPct: 0,
        ptpLevelIdx: 0,
        ptpLevelsRealized: 0,
      };
      state.openPositions.push(newPos);
      if (!state.tradingDays.includes(state.day)) {
        state.tradingDays.push(state.day);
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
        ...(cfg.partialTakeProfit ? { ptpConfig: cfg.partialTakeProfit } : {}),
        ...(cfg.breakEven ? { beThreshold: cfg.breakEven.threshold } : {}),
      });
    }
  }

  state.barsSeen += 1;
  state.lastBarOpenTime = lastBar.openTime;
  return result;
}

// ─── Backtest harness — used by parity tests + V4-Sim equivalence ──────

export interface SimulateResult {
  passed: boolean;
  reason: "profit_target" | "daily_loss" | "total_loss" | "time";
  passDay?: number;
  finalEquityPct: number;
  trades: ClosedTradeV4[];
  state: FtmoLiveStateV4;
}

/**
 * Drive a complete challenge by polling pollLive() bar-by-bar across the
 * window. Used for parity tests vs. V4-simulator and for backtests.
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
      sliceByAsset[k] = alignedCandles[k].slice(0, i + 1);
    }
    // Build sliced ATR series (must align with sliced candles — same length).
    const slicedAtr: Record<string, (number | null)[]> = {};
    if (cfg.chandelierExit) {
      for (const k of Object.keys(atrSeriesByAsset)) {
        slicedAtr[k] = atrSeriesByAsset[k].slice(0, i + 1);
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
        reason: r.failReason ?? "time",
        finalEquityPct: state.equity - 1,
        trades: state.closedTrades,
        state,
      };
    }
  }

  // Window exhausted — end-of-time check. FTMO rule: if target was hit at
  // any point AND minTradingDays satisfied, the challenge passed (subsequent
  // give-back doesn't void the pass, as long as DL/TL didn't trip).
  const passed =
    state.firstTargetHitDay !== null &&
    state.tradingDays.length >= cfg.minTradingDays;
  return {
    passed,
    reason: passed ? "profit_target" : "time",
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
