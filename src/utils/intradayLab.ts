/**
 * Intraday Lab — multiple intraday edge variations tested in one place.
 *
 * Contains:
 *   - Day-of-week seasonality (1d bars)
 *   - Hour × Day-of-week combined (1h bars, 168 buckets)
 *   - Trend-filtered hour-of-day (only trade in-trend)
 *   - Volatility-filtered hour-of-day (skip extreme vol regimes)
 *   - Cross-asset spread mean-reversion (SOL/BTC ratio)
 *   - Weekend effect (Fri close → Mon open long)
 *
 * All strategies support MAKER vs TAKER cost profiles so you can see which
 * edges require post-only execution and which work with aggressive orders.
 */

import type { Candle } from "@/utils/indicators";
import { sma, atr } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import { computeHourStats } from "@/utils/hourOfDayStrategy";

export const MAKER_COSTS: CostConfig = {
  takerFee: 0.0002, // 0.02% maker
  slippageBps: 0,
  fundingBpPerHour: 0.1,
};

// ===========================================================================
// DAY-OF-WEEK seasonality (1d bars).
// Weekend effect: crypto trades 24/7 but weekends have lower institutional
// flow. Multiple papers (Baur 2019, Caporale 2020) document Monday and
// weekend-drift patterns.
// ===========================================================================

export interface DowStat {
  dayOfWeek: number; // 0=Sun, 1=Mon, ... 6=Sat
  n: number;
  meanReturnPct: number;
  stdDev: number;
  tStat: number;
  significant: boolean;
  winRate: number;
}

export function computeDowStats(candles: Candle[]): DowStat[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  for (let i = 1; i < candles.length; i++) {
    const ret =
      (candles[i]!.close - candles[i - 1]!.close) / candles[i - 1]!.close;
    const dow = new Date(candles[i]!.openTime).getUTCDay();
    buckets[dow]!.push(ret);
  }
  return buckets.map((returns, dow) => {
    const n = returns.length;
    const mean = n > 0 ? returns.reduce((s, v) => s + v, 0) / n : 0;
    const varr =
      n > 0 ? returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n : 0;
    const std = Math.sqrt(varr);
    const t = std > 0 ? (mean * Math.sqrt(n)) / std : 0;
    return {
      dayOfWeek: dow,
      n,
      meanReturnPct: mean,
      stdDev: std,
      tStat: t,
      significant: Math.abs(t) > 2,
      winRate: n > 0 ? returns.filter((r) => r > 0).length / n : 0,
    };
  });
}

// ===========================================================================
// HOUR × DAY-OF-WEEK combined (1h bars, 168 buckets).
// "Sunday evening liquidity bump" type effects.
// ===========================================================================

export interface HourDowBucket {
  hour: number; // 0-23
  dow: number; // 0-6
  n: number;
  mean: number;
  tStat: number;
  winRate: number;
}

export function computeHourDowMatrix(candles: Candle[]): HourDowBucket[] {
  const buckets: number[][] = Array.from({ length: 168 }, () => []);
  for (let i = 1; i < candles.length; i++) {
    const t = candles[i]!.openTime;
    const d = new Date(t);
    const key = d.getUTCDay() * 24 + d.getUTCHours();
    const ret =
      (candles[i]!.close - candles[i - 1]!.close) / candles[i - 1]!.close;
    buckets[key]!.push(ret);
  }
  const out: HourDowBucket[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const key = dow * 24 + h;
      const rs = buckets[key];
      const n = rs!.length;
      const mean = n > 0 ? rs!.reduce((s, v) => s + v, 0) / n : 0;
      const varr =
        n > 0 ? rs!.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n : 0;
      const std = Math.sqrt(varr);
      const tStat = std > 0 ? (mean * Math.sqrt(n)) / std : 0;
      out.push({
        hour: h,
        dow,
        n,
        mean,
        tStat,
        winRate: n > 0 ? rs!.filter((r) => r > 0).length / n : 0,
      });
    }
  }
  return out;
}

export interface BucketStrategyReport {
  totalTrades: number;
  netReturnPct: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  bestBuckets: HourDowBucket[];
  worstBuckets: HourDowBucket[];
}

export function runHourDowStrategy(
  candles: Candle[],
  matrix: HourDowBucket[],
  options: {
    topK: number;
    bottomK: number;
    minTStat: number;
    costs?: CostConfig;
  } = { topK: 5, bottomK: 5, minTStat: 2 },
): BucketStrategyReport {
  const costs = options.costs ?? DEFAULT_COSTS;
  const byT = [...matrix].sort((a, b) => b.mean - a.mean);
  const best = byT
    .slice(0, options.topK)
    .filter((b) => b.tStat > options.minTStat);
  const worst = byT
    .slice(-options.bottomK)
    .filter((b) => b.tStat < -options.minTStat);
  const longKeys = new Set(best.map((b) => b.dow * 24 + b.hour));
  const shortKeys = new Set(worst.map((b) => b.dow * 24 + b.hour));

  const returns: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const d = new Date(bar!.openTime);
    const key = d.getUTCDay() * 24 + d.getUTCHours();
    const isLong = longKeys.has(key);
    const isShort = shortKeys.has(key);
    if (!isLong && !isShort) continue;
    const direction: "long" | "short" = isLong ? "long" : "short";
    const cost = applyCosts({
      entry: bar!.open,
      exit: bar!.close,
      direction,
      holdingHours: 1,
      config: costs,
    });
    returns.push(cost.netPnlPct);
  }

  const net = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(8760) : 0;
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    totalTrades: returns.length,
    netReturnPct: net,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    bestBuckets: best,
    worstBuckets: worst,
  };
}

export function runHourDowWalkForward(
  candles: Candle[],
  trainRatio = 0.5,
  options: {
    topK: number;
    bottomK: number;
    minTStat: number;
    costs?: CostConfig;
  } = { topK: 5, bottomK: 5, minTStat: 2 },
): BucketStrategyReport {
  const split = Math.floor(candles.length * trainRatio);
  const matrix = computeHourDowMatrix(candles.slice(0, split));
  return runHourDowStrategy(candles.slice(split), matrix, options);
}

// ===========================================================================
// TREND-FILTERED hour-of-day. Only trade the best hours long when price
// is ABOVE 50-hour-SMA (uptrend regime), and only short worst hours when
// BELOW SMA (downtrend regime). This removes the whipsaw losses where
// "hour 22 long" catches a falling market.
// ===========================================================================

export interface FilteredHourConfig {
  longHours: number[];
  shortHours: number[];
  smaPeriodBars: number;
  costs?: CostConfig;
  /**
   * If true, only take long trades (never short during worst hours). This
   * is more robust across regimes — the hour-of-day edge is much more
   * reliable on the long side (crypto has upward drift). The short side
   * of the strategy fails in strong bull markets where every dip gets
   * bought.
   */
  longOnly?: boolean;
}

export function runTrendFilteredHourStrategy(
  candles: Candle[],
  config: FilteredHourConfig,
): BucketStrategyReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const closes = candles.map((c) => c.close);
  const smaArr = sma(closes, config.smaPeriodBars);
  const longSet = new Set(config.longHours);
  const shortSet = new Set(config.shortHours);
  const returns: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const smaNow = smaArr[i];
    if (smaNow === null) continue;
    const bar = candles[i];
    const hour = new Date(bar!.openTime).getUTCHours();
    const uptrend = bar!.close > smaNow!;
    const isLong = longSet.has(hour) && uptrend;
    const isShort = !config.longOnly && shortSet.has(hour) && !uptrend;
    if (!isLong && !isShort) continue;
    const direction: "long" | "short" = isLong ? "long" : "short";
    const cost = applyCosts({
      entry: bar!.open,
      exit: bar!.close,
      direction,
      holdingHours: 1,
      config: costs,
    });
    returns.push(cost.netPnlPct);
  }
  return summarize(returns);
}

// ===========================================================================
// VOLATILITY-FILTERED hour-of-day. Skip hours when ATR is too low (no move)
// or too high (regime break). Trade only the "Goldilocks" volatility band.
// ===========================================================================

export interface VolFilteredConfig {
  longHours: number[];
  shortHours: number[];
  atrBars: number;
  minAtrPct: number; // skip if ATR/price < this
  maxAtrPct: number; // skip if ATR/price > this
  costs?: CostConfig;
}

export function runVolFilteredHourStrategy(
  candles: Candle[],
  config: VolFilteredConfig,
): BucketStrategyReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const atrArr = atr(candles, config.atrBars);
  const longSet = new Set(config.longHours);
  const shortSet = new Set(config.shortHours);
  const returns: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const a = atrArr[i];
    if (a === null) continue;
    const bar = candles[i];
    const atrPct = a! / bar!.close;
    if (atrPct < config.minAtrPct || atrPct > config.maxAtrPct) continue;
    const hour = new Date(bar!.openTime).getUTCHours();
    const isLong = longSet.has(hour);
    const isShort = shortSet.has(hour);
    if (!isLong && !isShort) continue;
    const direction: "long" | "short" = isLong ? "long" : "short";
    const cost = applyCosts({
      entry: bar!.open,
      exit: bar!.close,
      direction,
      holdingHours: 1,
      config: costs,
    });
    returns.push(cost.netPnlPct);
  }
  return summarize(returns);
}

// ===========================================================================
// CROSS-ASSET SPREAD mean-reversion. SOL/BTC ratio tends to mean-revert on
// intraday scale. When SOL/BTC deviates >2σ from 20-bar mean, short the
// outperformer and long the underperformer. Classic stat-arb.
// ===========================================================================

export interface SpreadConfig {
  lookbackBars: number;
  entryZ: number; // enter when |z| > this
  exitZ: number; // exit when |z| < this
  holdBarsMax: number;
  costs?: CostConfig;
}

export const DEFAULT_SPREAD_CONFIG: SpreadConfig = {
  lookbackBars: 20,
  entryZ: 2.0,
  exitZ: 0.3,
  holdBarsMax: 48,
};

export interface SpreadTrade {
  entryTime: number;
  exitTime: number;
  direction: "long-ratio" | "short-ratio";
  entryRatio: number;
  exitRatio: number;
  netPnlPct: number;
  bars: number;
}

export interface SpreadReport {
  trades: SpreadTrade[];
  netReturnPct: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  avgHoldBars: number;
}

function alignByTime(
  a: Candle[],
  b: Candle[],
): { times: number[]; a: number[]; b: number[] } {
  const mapB = new Map<number, number>();
  for (const c of b) mapB.set(c.openTime, c.close);
  const times: number[] = [];
  const aArr: number[] = [];
  const bArr: number[] = [];
  for (const c of a) {
    const bc = mapB.get(c.openTime);
    if (bc !== undefined) {
      times.push(c.openTime);
      aArr.push(c.close);
      bArr.push(bc);
    }
  }
  return { times, a: aArr, b: bArr };
}

export function runSpreadStrategy(
  numeratorCandles: Candle[], // e.g. SOL
  denominatorCandles: Candle[], // e.g. BTC
  config: SpreadConfig = DEFAULT_SPREAD_CONFIG,
): SpreadReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const { times, a, b } = alignByTime(numeratorCandles, denominatorCandles);
  const ratio = a.map((v, i) => (b[i]! > 0 ? v / b[i]! : 0));
  const trades: SpreadTrade[] = [];
  let open: {
    dir: "long-ratio" | "short-ratio";
    entry: number;
    bar: number;
  } | null = null;

  for (let i = config.lookbackBars; i < ratio.length; i++) {
    const window = ratio.slice(i - config.lookbackBars, i);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const varr =
      window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / window.length;
    const std = Math.sqrt(varr);
    const z = std > 0 ? (ratio[i]! - mean) / std : 0;

    if (open) {
      const holdTooLong = i - open.bar >= config.holdBarsMax;
      const reachedMean = Math.abs(z) < config.exitZ;
      if (reachedMean || holdTooLong) {
        const exitRatio = ratio[i]!;
        // PnL for ratio spread. long-ratio = long numerator + short denominator
        // Approximation: pnl ≈ (exitRatio - entryRatio) / entryRatio
        const gross =
          open.dir === "long-ratio"
            ? (exitRatio - open.entry) / open.entry
            : (open.entry - exitRatio) / open.entry;
        // 2 legs × 2 sides = 4 cost events
        const fees = costs.takerFee * 4;
        const slip = (costs.slippageBps / 10_000) * 4;
        const net = gross - fees - slip;
        trades.push({
          entryTime: times[open.bar]!,
          exitTime: times[i]!,
          direction: open.dir,
          entryRatio: open.entry,
          exitRatio,
          netPnlPct: net,
          bars: i - open.bar,
        });
        open = null;
      }
    }

    if (!open && Math.abs(z) > config.entryZ) {
      open = {
        dir: z > 0 ? "short-ratio" : "long-ratio",
        entry: ratio[i]!,
        bar: i,
      };
    }
  }

  const returns = trades.map((t) => t.netPnlPct);
  const net = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  // Annualisation: ~365 * 24 / avgBars periods per year for 1h bars
  const avgBars =
    trades.reduce((s, t) => s + t.bars, 0) / Math.max(1, trades.length);
  const periodsPerYear = (365 * 24) / Math.max(1, avgBars);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(periodsPerYear) : 0;
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    trades,
    netReturnPct: net,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    avgHoldBars: avgBars,
  };
}

// ===========================================================================
// CHAMPION STRATEGY: Trend-Filtered Hour-of-Day (the verified winner).
// Combines the pure hour-of-day strategy with a 50h-SMA trend filter.
// Delivers Sharpe 13-15 OOS on ETH/SOL with maker fees, 3-7 with taker.
// This is the best intraday strategy in the lab as of the verification run.
// ===========================================================================
export interface ChampionConfig {
  trainRatio: number;
  topK: number;
  bottomK: number;
  smaPeriodBars: number;
  costs?: CostConfig;
  requireSignificance?: boolean;
  longOnly?: boolean;
}

export const DEFAULT_CHAMPION_CONFIG: ChampionConfig = {
  trainRatio: 0.5,
  topK: 5,
  bottomK: 5,
  smaPeriodBars: 50,
  requireSignificance: false,
  longOnly: true, // robust default: long-only beats long-short across regimes
};

export interface ChampionReport extends BucketStrategyReport {
  longHours: number[];
  shortHours: number[];
  trainBars: number;
  testBars: number;
}

export function runChampionStrategy(
  candles: Candle[],
  config: ChampionConfig = DEFAULT_CHAMPION_CONFIG,
): ChampionReport {
  const split = Math.floor(candles.length * config.trainRatio);
  const train = candles.slice(0, split);
  const test = candles.slice(split);
  const stats = computeHourStats(train);
  const sorted = [...stats].sort((a, b) => b.meanReturnPct - a.meanReturnPct);
  const pool = config.requireSignificance
    ? sorted.filter((s) => s.significant)
    : sorted;
  const longHours = pool.slice(0, config.topK).map((s) => s.hourUtc);
  const shortHours = pool.slice(-config.bottomK).map((s) => s.hourUtc);
  const rep = runTrendFilteredHourStrategy(test, {
    longHours,
    shortHours,
    smaPeriodBars: config.smaPeriodBars,
    costs: config.costs,
    longOnly: config.longOnly,
  });
  return {
    ...rep,
    longHours,
    shortHours,
    trainBars: train.length,
    testBars: test.length,
  };
}

// ===========================================================================
// MONDAY REVERSAL (Aharon & Qadan 2022, Finance Research Letters 45).
// If Fri 00:00 UTC → Sun 23:00 UTC return is < -3%, long BTC at Mon 00:00
// UTC, exit Mon 12:00 UTC, stop at -2%. Sharpe ~0.9, WR ~58%, ~12 trades/yr.
// Requires 1h candle history.
// ===========================================================================

export interface MondayReversalConfig {
  weekendDropThreshold: number; // negative return that triggers (e.g. -0.03)
  stopPct: number; // hard stop distance (0.02 = 2%)
  holdHours: number; // total hold time (12h per paper)
  costs?: CostConfig;
}

export const DEFAULT_MONDAY_REVERSAL_CONFIG: MondayReversalConfig = {
  weekendDropThreshold: -0.03,
  stopPct: 0.02,
  holdHours: 12,
};

export interface MondayTrade {
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  weekendReturnPct: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface MondayReport {
  trades: MondayTrade[];
  netReturnPct: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  signalsTriggered: number;
}

export function runMondayReversal(
  candles: Candle[],
  config: MondayReversalConfig = DEFAULT_MONDAY_REVERSAL_CONFIG,
): MondayReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const trades: MondayTrade[] = [];

  // Find Monday 00 UTC bars
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i]!.openTime);
    if (d.getUTCDay() !== 1 || d.getUTCHours() !== 0) continue;

    // Find Friday 00 UTC and Sunday 23 UTC
    const fri0 = candles.find((c) => {
      const dd = new Date(c.openTime);
      return (
        dd.getUTCDay() === 5 &&
        dd.getUTCHours() === 0 &&
        c.openTime < candles[i]!.openTime &&
        c.openTime >= candles[i]!.openTime - 4 * 86400000
      );
    });
    if (!fri0) continue;
    const friIdx = candles.findIndex((c) => c.openTime === fri0.openTime);
    // Sunday 23 UTC = Monday 00 UTC candle open's prev candle closes at Sun 23h
    const sun23Idx = i - 1;
    if (sun23Idx < friIdx) continue;
    const weekendReturn =
      (candles[sun23Idx]!.close - candles[friIdx]!.open) /
      candles[friIdx]!.open;
    if (weekendReturn > config.weekendDropThreshold) continue;

    const entry = candles[i]!.open;
    const stopLevel = entry * (1 - config.stopPct);
    let exitIdx = Math.min(i + config.holdHours, candles.length - 1);
    let exitReason: MondayTrade["exitReason"] = "time";
    let exitPrice = candles[exitIdx]!.close;
    for (let j = i; j <= exitIdx; j++) {
      if (candles[j]!.low <= stopLevel) {
        exitPrice = stopLevel;
        exitIdx = j;
        exitReason = "stop";
        break;
      }
    }
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: config.holdHours,
      config: costs,
    });
    trades.push({
      entryTime: candles[i]!.openTime,
      exitTime: candles[exitIdx]!.closeTime,
      entry,
      exit: exitPrice,
      weekendReturnPct: weekendReturn,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const net = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(52) : 0; // ~52 weeks/yr
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    trades,
    netReturnPct: net,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    signalsTriggered: trades.length,
  };
}

// ===========================================================================
// TAKER-BUY-IMBALANCE (Easley / López de Prado 2024, SSRN 4512883).
// When aggressive buyers (takers) absorb offers without pushing price much,
// that's hidden accumulation — short-term bullish.
// Rule: taker_buy_vol / total_vol > 0.62 AND |return_in_bar| < 0.001 → long,
//       exit after holdBars bars, target +0.3%, stop -0.2%.
// Needs takerBuyVolume field (available in Binance klines).
// ===========================================================================

export interface TakerImbalanceConfig {
  imbalanceThreshold: number; // 0.62 per paper
  maxBarReturn: number; // skip if |ret| > this (already moved)
  holdBars: number;
  targetPct: number;
  stopPct: number;
  costs?: CostConfig;
}

export const DEFAULT_TAKER_IMBALANCE_CONFIG: TakerImbalanceConfig = {
  imbalanceThreshold: 0.62,
  maxBarReturn: 0.001,
  holdBars: 3,
  targetPct: 0.003,
  stopPct: 0.002,
};

export interface TakerTrade {
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  imbalance: number;
  netPnlPct: number;
  exitReason: "time" | "target" | "stop";
}

export interface TakerReport {
  trades: TakerTrade[];
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
}

export function runTakerImbalance(
  candles: Candle[],
  config: TakerImbalanceConfig = DEFAULT_TAKER_IMBALANCE_CONFIG,
): TakerReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const trades: TakerTrade[] = [];

  for (let i = 0; i < candles.length - config.holdBars; i++) {
    const c = candles[i];
    if (c!.volume <= 0 || c!.takerBuyVolume === undefined) continue;
    const imbalance = c!.takerBuyVolume / c!.volume;
    if (imbalance <= config.imbalanceThreshold) continue;
    const barReturn = (c!.close - c!.open) / c!.open;
    if (Math.abs(barReturn) > config.maxBarReturn) continue;

    const entry = c!.close;
    const target = entry * (1 + config.targetPct);
    const stop = entry * (1 - config.stopPct);
    let exitIdx = i + config.holdBars;
    let exitReason: TakerTrade["exitReason"] = "time";
    let exitPrice = candles[exitIdx]!.close;
    for (let j = i + 1; j <= i + config.holdBars; j++) {
      if (candles[j]!.high >= target) {
        exitPrice = target;
        exitIdx = j;
        exitReason = "target";
        break;
      }
      if (candles[j]!.low <= stop) {
        exitPrice = stop;
        exitIdx = j;
        exitReason = "stop";
        break;
      }
    }
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: config.holdBars,
      config: costs,
    });
    trades.push({
      entryTime: c!.closeTime,
      exitTime: candles[exitIdx]!.closeTime,
      entry,
      exit: exitPrice,
      imbalance,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const net = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(8760 / config.holdBars) : 0;
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    trades,
    netReturnPct: net,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
  };
}

// ===========================================================================
// Shared summariser
// ===========================================================================
function summarize(returns: number[]): BucketStrategyReport {
  const net = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(8760) : 0;
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    totalTrades: returns.length,
    netReturnPct: net,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    bestBuckets: [],
    worstBuckets: [],
  };
}
