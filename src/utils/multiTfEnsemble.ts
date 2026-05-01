/**
 * Multi-TF Ensemble Signal Aggregator
 *
 * Combines LONG entry-signals from three timeframes (15m / 30m / 2h) on the
 * same asset and only fires a trade when at least N of M configs agree
 * within a short confluence window. Goal: improve edge-to-variance ratio
 * by trading less but with higher win-rate confluence.
 *
 * Design (round 48, 2026-05-01):
 *   1. Caller pre-computes `Daytrade24hTrade[]` per (TF, asset) using
 *      `detectAsset()` from ftmoDaytrade24h.
 *   2. We fold those TF-specific trade-streams into ensemble-trades on a
 *      common 30m grid: for each 30m bar t, count how many of the three
 *      configs produced a LONG entry inside the bar's confluence window
 *      (2h config: 4 bars wide, 30m: 1 bar, 15m: 2 bars).
 *   3. If `votes >= entryThreshold`, emit one ensemble entry sized by
 *      `sizeScale[votes]` (e.g. {2: 0.6, 3: 1.0}).
 *   4. Exit rule: longest-hold TF (V5_QUARTZ_LITE 2h: holdBars=300) defines
 *      the time-stop. SL/TP taken from the V5_QUARTZ_LITE asset config.
 *      Conservative early-exit: if `votes < exitThreshold` voted SELL
 *      (i.e. opposite-direction signal in same bar), close. — but our
 *      configs are long-only so this collapses to "no early exit".
 *   5. The ensemble emits trades into a single equity loop with FTMO rules
 *      (handled by the caller via `runEnsembleEquityLoop`).
 *
 * Pragmatic constraint: only assets present in ALL THREE config baskets
 * benefit from the full 3-vote logic. Common cores between V5_QUARTZ_LITE
 * (BTC/ETH/BNB/ADA/LTC/BCH/ETC/XRP/AAVE) and V12_30M / V16_15M (BTC/ETH/SOL):
 *   {BTC, ETH}.
 * Other V5 assets only have the V5 vote — for them we either fall back to
 * single-TF V5 entries (`fallbackSingleTf=true`) or skip.
 */
import {
  detectAsset,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hTrade,
  type Daytrade24hAssetCfg,
} from "./ftmoDaytrade24h";
import type { Candle } from "./indicators";
import { atr } from "./indicators";

export type EnsembleTfLabel = "15m" | "30m" | "2h";

export interface EnsembleTfEntry {
  label: EnsembleTfLabel;
  cfg: FtmoDaytrade24hConfig;
  /** Asset symbol whitelist intersected with cfg.assets — restricts which
   *  detectAsset calls are made.  Lets us run V12_30M only on BTC/ETH. */
  assetWhitelist?: string[];
  data: Record<string, Candle[]>;
  /** Bar duration in ms (15m → 900000, 30m → 1800000, 2h → 7200000). */
  barMs: number;
}

export interface EnsembleParams {
  /** Minimum LONG votes to enter (default 2 of 3). */
  entryThreshold: number;
  /** Map vote-count → size-scale (e.g. {2: 0.6, 3: 1.0}). Below threshold → 0. */
  sizeScaleByVotes: Record<number, number>;
  /** Confluence window in ms (default 30 minutes — one 30m bar). */
  confluenceWindowMs?: number;
  /** Use V5_QUARTZ_LITE single-TF entry as fallback for assets only present in
   *  the 2h config (no 15m/30m vote available). */
  fallbackSingleTf?: boolean;
  /** Asset-cfg lookup for SL/TP/holdBars on the ensemble entry. */
  exitCfg: FtmoDaytrade24hConfig;
}

export interface EnsembleEntry {
  symbol: string;
  sourceSymbol: string;
  entryTime: number;
  votes: number;
  contributors: EnsembleTfLabel[];
  /** Riskfraction × volMult × sizeScale[votes] applied at entry. */
  effRiskFrac: number;
  /** Raw entry-bar close from the 30m grid (used for SL/TP anchors). */
  entryPrice: number;
  /** Asset config used for stop/TP/holdBars calculation (from exitCfg). */
  assetCfg: Daytrade24hAssetCfg;
}

/**
 * For each asset symbol, collect entry-times per TF.  Returns `entryTimes`
 * keyed by TF label so the aggregator can vote.
 */
export function collectTfEntryTimes(
  tfs: EnsembleTfEntry[],
): Map<string, Record<EnsembleTfLabel, Set<number>>> {
  const out = new Map<string, Record<EnsembleTfLabel, Set<number>>>();
  for (const tf of tfs) {
    const crossKey = tf.cfg.crossAssetFilter?.symbol;
    const crossCandles = crossKey ? tf.data[crossKey] : undefined;
    for (const asset of tf.cfg.assets) {
      // Ensemble votes by *underlying* market — virtual assets like ETH-MR
      // and ETH-MOM both feed ETHUSDT votes. Use sourceSymbol (or symbol).
      const sourceSym = asset.sourceSymbol ?? asset.symbol;
      if (tf.assetWhitelist && !tf.assetWhitelist.includes(sourceSym)) continue;
      const candles = tf.data[sourceSym];
      if (!candles || candles.length < 100) continue;
      const crossForAsset =
        crossCandles && crossCandles.length === candles.length
          ? crossCandles
          : undefined;
      let trades: Daytrade24hTrade[] = [];
      try {
        trades = detectAsset(candles, asset, tf.cfg, crossForAsset);
      } catch {
        continue;
      }
      // Long-only ensemble for round 48
      const longs = trades.filter((t) => t.direction === "long");
      if (!out.has(sourceSym))
        out.set(sourceSym, {
          "15m": new Set(),
          "30m": new Set(),
          "2h": new Set(),
        });
      const buckets = out.get(sourceSym)!;
      for (const t of longs) buckets[tf.label].add(t.entryTime);
    }
  }
  return out;
}

/**
 * Aggregate the TF vote-buckets into ensemble entries on a common 30m grid.
 *
 * For each 30m candle bar (t, t+30m), count votes:
 *   - 30m vote = entry-time exactly t
 *   - 15m vote = any entry-time in [t, t+30m)
 *   - 2h vote  = any entry-time in [t-90m, t+30m)  (a 2h bar is 4× 30m)
 *
 * Emits one EnsembleEntry per asset per 30m bar that crosses entryThreshold.
 * Cooldown: once an entry fires for an asset, no new entry on that asset
 * within the 2h hold-window (prevents duplicate entries within a single
 * 2h-trend signal that re-votes on every 30m bar).
 */
export function aggregateEnsembleEntries(
  votes: Map<string, Record<EnsembleTfLabel, Set<number>>>,
  thirtyMinGrid: number[], // sorted openTimes from a 30m candle stream (e.g. ETH 30m)
  thirtyMinClose: Map<string, Map<number, number>>, // sourceSym -> openTime -> close
  params: EnsembleParams,
): EnsembleEntry[] {
  const out: EnsembleEntry[] = [];
  const COOLDOWN_MS = 2 * 3600_000; // one 2h bar
  const winMs = params.confluenceWindowMs ?? 30 * 60_000;

  for (const [sourceSym, buckets] of votes) {
    const closeMap = thirtyMinClose.get(sourceSym);
    if (!closeMap) continue;
    // Lookup asset-cfg in exitCfg by sourceSymbol match
    const assetCfg = params.exitCfg.assets.find(
      (a) => (a.sourceSymbol ?? a.symbol) === sourceSym,
    );
    if (!assetCfg) continue;
    // PERF: pre-sort vote arrays once per asset for O(log N) binary lookup.
    const arr15m = [...buckets["15m"]].sort((a, b) => a - b);
    const arr2h = [...buckets["2h"]].sort((a, b) => a - b);
    // Helper: returns true if any value in sorted array is in [lo, hi).
    const anyInRange = (arr: number[], lo: number, hi: number): boolean => {
      if (arr.length === 0) return false;
      // binary lower-bound for lo
      let l = 0,
        r = arr.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (arr[m] < lo) l = m + 1;
        else r = m;
      }
      return l < arr.length && arr[l] < hi;
    };
    let cooldownUntil = -Infinity;
    for (const t of thirtyMinGrid) {
      if (t < cooldownUntil) continue;
      const has30m = buckets["30m"].has(t);
      const has15m = anyInRange(arr15m, t, t + winMs);
      const has2h = anyInRange(arr2h, t - 90 * 60_000, t + winMs);
      const votesCount = (has30m ? 1 : 0) + (has15m ? 1 : 0) + (has2h ? 1 : 0);
      let scale = 0;
      if (votesCount >= params.entryThreshold) {
        scale = params.sizeScaleByVotes[votesCount] ?? 0;
      } else if (
        params.fallbackSingleTf &&
        has2h &&
        params.entryThreshold === 1
      ) {
        scale = params.sizeScaleByVotes[1] ?? 0;
      }
      if (scale <= 0) continue;
      const entryPrice = closeMap.get(t);
      if (!entryPrice || !isFinite(entryPrice)) continue;
      const contribs: EnsembleTfLabel[] = [];
      if (has15m) contribs.push("15m");
      if (has30m) contribs.push("30m");
      if (has2h) contribs.push("2h");
      out.push({
        symbol: assetCfg.symbol,
        sourceSymbol: sourceSym,
        entryTime: t,
        votes: votesCount,
        contributors: contribs,
        effRiskFrac: assetCfg.riskFrac * scale,
        entryPrice,
        assetCfg,
      });
      cooldownUntil = t + COOLDOWN_MS;
    }
  }
  out.sort((a, b) => a.entryTime - b.entryTime);
  return out;
}

/**
 * Walk forward through 30m bars, opening EnsembleEntries and tracking
 * exits via SL/TP/timeStop using the asset-cfg + exit-cfg engine settings.
 * Single-account FTMO equity loop (caps applied via cfg.liveCaps).
 *
 * NB: We use 30m bars for both entry timing and SL/TP intra-bar checks.
 * Conservative tie-break: if both SL and TP touched in the same 30m bar,
 * SL wins (worst-case assumption for backtest realism).
 */
export function runEnsembleEquityLoop(
  entries: EnsembleEntry[],
  thirtyMinByAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  windowStartTs: number,
): FtmoDaytrade24hResult {
  const dayMs = 24 * 3600_000;
  let equity = 1.0;
  let peak = 1.0;
  let dayPeak = 1.0;
  let maxDd = 0;
  let maxHold = 0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: Daytrade24hTrade[] = [];
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const profitTarget = cfg.profitTarget;
  const dailyLoss = cfg.maxDailyLoss;
  const totalLoss = cfg.maxTotalLoss;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;
  const stopPctCap = cfg.liveCaps?.maxStopPct ?? 0.05;
  const riskFracCap = cfg.liveCaps?.maxRiskFrac ?? 0.4;
  const leverage = cfg.leverage ?? 2;
  let firstTargetDay: number | null = null;

  // Pre-compute openTime → bar-index per asset for O(1) intra-bar walk
  const idxByAsset: Record<string, Map<number, number>> = {};
  for (const [k, arr] of Object.entries(thirtyMinByAsset)) {
    const m = new Map<number, number>();
    arr.forEach((c, i) => m.set(c.openTime, i));
    idxByAsset[k] = m;
  }

  for (const entry of entries) {
    const day = Math.floor((entry.entryTime - windowStartTs) / dayMs);
    if (day < 0) continue;
    if (day >= maxDays) break;
    if (!dayStart.has(day)) {
      dayStart.set(day, equity);
      dayPeak = equity;
    }
    if (firstTargetDay !== null && cfg.pauseAtTargetReached) {
      // After target hit, count trading-day virtually until min-days
      tradingDays.add(day);
      if (tradingDays.size >= minDays) break;
      continue;
    }
    if (trail !== undefined) {
      const drop = (dayPeak - equity) / Math.max(dayPeak, 1e-9);
      if (drop >= trail) continue;
    }

    // Open: walk 30m bars from entry until SL / TP / timeStop
    const candles = thirtyMinByAsset[entry.sourceSymbol];
    if (!candles) continue;
    const idxMap = idxByAsset[entry.sourceSymbol];
    const startIdx = idxMap.get(entry.entryTime);
    if (startIdx === undefined) continue;
    // Resolve SL/TP using asset-cfg (clamped by liveCaps.maxStopPct)
    const stopPct = Math.min(entry.assetCfg.stopPct ?? cfg.stopPct, stopPctCap);
    const tpPct = entry.assetCfg.tpPct ?? cfg.tpPct;
    // Hold-bars on 30m grid: V5_QUARTZ_LITE has holdBars=300 (2h bars)
    // → on 30m grid that's 300×4 = 1200. Keep direct exitCfg holdBars when
    // already in 30m units; else multiply by tf-ratio.
    const holdBars30m = (entry.assetCfg.holdBars ?? cfg.holdBars) * 4;

    const entryPrice = entry.entryPrice;
    const stopPrice = entryPrice * (1 - stopPct);
    const tpPrice = entryPrice * (1 + tpPct);
    let exitPrice: number | null = null;
    let exitTime = entry.entryTime;
    let exitReason: "tp" | "stop" | "time" = "time";
    let endIdx = Math.min(candles.length - 1, startIdx + holdBars30m);
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const c = candles[i];
      if (c.low <= stopPrice) {
        exitPrice = stopPrice;
        exitTime = c.openTime;
        exitReason = "stop";
        break;
      }
      if (c.high >= tpPrice) {
        exitPrice = tpPrice;
        exitTime = c.openTime;
        exitReason = "tp";
        break;
      }
    }
    if (exitPrice === null) {
      const c = candles[endIdx] ?? candles[candles.length - 1];
      exitPrice = c.close;
      exitTime = c.openTime;
      exitReason = "time";
    }
    const rawPnl = (exitPrice - entryPrice) / entryPrice;
    // Round-trip costs (cost + slippage) — same convention as ftmoDaytrade24h
    const costBp =
      (entry.assetCfg.costBp ?? 0) + (entry.assetCfg.slippageBp ?? 0);
    const adjustedRaw = rawPnl - 2 * (costBp / 10_000);
    const effRisk = Math.min(entry.effRiskFrac, riskFracCap);
    const effPnl = Math.max(adjustedRaw * leverage * effRisk, -effRisk * 1.5);
    equity *= 1 + effPnl;
    if (equity > peak) peak = equity;
    if (equity > dayPeak) dayPeak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;
    const holdH = (exitTime - entry.entryTime) / 3600_000;
    if (holdH > maxHold) maxHold = holdH;
    tradingDays.add(day);
    executed.push({
      symbol: entry.symbol,
      direction: "long",
      entryTime: entry.entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      rawPnl: adjustedRaw,
      effPnl,
      day,
      entryDay: day,
      exitReason,
      holdHours: holdH,
      volMult: 1,
    });

    // FTMO rule checks
    if (equity <= 1 - totalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        trades: executed,
        maxHoldHoursObserved: maxHold,
      };
    }
    const sod = dayStart.get(day) ?? 1;
    if (equity / sod - 1 <= -dailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        trades: executed,
        maxHoldHoursObserved: maxHold,
      };
    }
    if (equity >= 1 + profitTarget && firstTargetDay === null) {
      firstTargetDay = day;
      if (tradingDays.size >= minDays) {
        return {
          passed: true,
          reason: "profit_target",
          finalEquityPct: equity - 1,
          maxDrawdown: maxDd,
          uniqueTradingDays: tradingDays.size,
          passDay: Math.max(day + 1, minDays),
          trades: executed,
          maxHoldHoursObserved: maxHold,
        };
      }
    }
  }

  if (firstTargetDay !== null && tradingDays.size >= minDays) {
    return {
      passed: true,
      reason: "profit_target",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDd,
      uniqueTradingDays: tradingDays.size,
      passDay: Math.max(firstTargetDay + 1, minDays),
      trades: executed,
      maxHoldHoursObserved: maxHold,
    };
  }
  if (tradingDays.size < minDays) {
    return {
      passed: false,
      reason: "insufficient_days",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDd,
      uniqueTradingDays: tradingDays.size,
      trades: executed,
      maxHoldHoursObserved: maxHold,
    };
  }
  return {
    passed: false,
    reason: "time",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDd,
    uniqueTradingDays: tradingDays.size,
    trades: executed,
    maxHoldHoursObserved: maxHold,
  };
}

/** Suppress unused-warning placeholder for atr import we keep for future use. */
void atr;
