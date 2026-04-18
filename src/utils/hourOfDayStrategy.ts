/**
 * Hour-of-Day Seasonality Strategy for Crypto.
 *
 * Research basis:
 *   - Baur & Dimpfl, "The volatility of Bitcoin…", Empirical Economics 2021
 *   - arxiv 2401.08732 (2024) "Intraday Return Predictability in
 *     Cryptocurrency Markets"
 *
 * Finding: BTC (and to a lesser extent ETH) has statistically significant
 * drift during NY-equity session close carryover (20:00-22:00 UTC). The
 * effect is strong enough to survive realistic fees on 1h bars.
 *
 * This module:
 *   1. Scans the full 1h candle history and computes per-hour mean return
 *      + t-stat to identify statistically significant hours.
 *   2. Builds a strategy that only trades during the top-k bullish hours
 *      long, or bottom-k bearish hours short (or both).
 *   3. Applies realistic cost model (entry + exit fees + slippage).
 *
 * Use: find which HOURS have persistent drift, trade those only. This is
 * the "simplest real intraday edge" per the 2024 paper.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface HourStat {
  hourUtc: number;
  n: number;
  meanReturnPct: number;
  stdDev: number;
  tStat: number;
  significant: boolean; // |t| > 2
  winRate: number;
}

export interface HourOfDayReport {
  hours: HourStat[];
  longTrades: HourTrade[];
  shortTrades: HourTrade[];
  netReturnPct: number;
  totalTrades: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  bestHours: number[];
  worstHours: number[];
}

export interface HourTrade {
  hourUtc: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  grossPnlPct: number;
  netPnlPct: number;
}

function tStatOf(mean: number, std: number, n: number): number {
  if (n < 2 || std === 0) return 0;
  return (mean * Math.sqrt(n)) / std;
}

export function computeHourStats(candles: Candle[]): HourStat[] {
  // Bucket per-bar pct-returns by UTC hour of bar open
  const buckets: { hour: number; returns: number[] }[] = [];
  for (let h = 0; h < 24; h++) buckets.push({ hour: h, returns: [] });

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (prev.close <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const hour = new Date(cur.openTime).getUTCHours();
    buckets[hour].returns.push(ret);
  }

  return buckets.map((b) => {
    const n = b.returns.length;
    const mean = n > 0 ? b.returns.reduce((s, v) => s + v, 0) / n : 0;
    const variance =
      n > 0
        ? b.returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n
        : 0;
    const std = Math.sqrt(variance);
    const wins = b.returns.filter((r) => r > 0).length;
    return {
      hourUtc: b.hour,
      n,
      meanReturnPct: mean,
      stdDev: std,
      tStat: tStatOf(mean, std, n),
      significant: Math.abs(tStatOf(mean, std, n)) > 2,
      winRate: n > 0 ? wins / n : 0,
    };
  });
}

export interface HourStrategyConfig {
  longTopK: number; // how many top-bullish hours to trade long
  shortBottomK: number; // how many bottom-bearish hours to trade short
  requireSignificance: boolean; // only trade hours where |t| > 2
  costs?: CostConfig;
}

export const DEFAULT_HOUR_STRATEGY_CONFIG: HourStrategyConfig = {
  longTopK: 3,
  shortBottomK: 3,
  requireSignificance: true,
};

/**
 * Builds the strategy, runs the trades on the exact candle history used to
 * compute the hour stats (in-sample by default). For true out-of-sample,
 * call `computeHourStats` on the first half and `runHourStrategy` on the
 * second half.
 */
export function runHourOfDayStrategy(
  candles: Candle[],
  stats: HourStat[],
  config: HourStrategyConfig = DEFAULT_HOUR_STRATEGY_CONFIG,
): HourOfDayReport {
  const costs = config.costs ?? DEFAULT_COSTS;

  const sortedByMean = [...stats].sort(
    (a, b) => b.meanReturnPct - a.meanReturnPct,
  );
  const bestHours = sortedByMean
    .slice(0, config.longTopK)
    .filter((s) => !config.requireSignificance || s.significant)
    .map((s) => s.hourUtc);
  const worstHours = sortedByMean
    .slice(-config.shortBottomK)
    .filter((s) => !config.requireSignificance || s.significant)
    .map((s) => s.hourUtc);

  const longSet = new Set(bestHours);
  const shortSet = new Set(worstHours);

  const longTrades: HourTrade[] = [];
  const shortTrades: HourTrade[] = [];

  // Each trade: enter at bar open (open price), exit at bar close (close).
  // That's a 1-hour directional bet; costs paid once (entry+exit).
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const hour = new Date(bar.openTime).getUTCHours();
    const isLong = longSet.has(hour);
    const isShort = shortSet.has(hour);
    if (!isLong && !isShort) continue;

    const direction = isLong ? "long" : "short";
    const cost = applyCosts({
      entry: bar.open,
      exit: bar.close,
      direction,
      holdingHours: 1,
      config: costs,
    });
    const trade: HourTrade = {
      hourUtc: hour,
      direction,
      entry: bar.open,
      exit: bar.close,
      entryTime: bar.openTime,
      exitTime: bar.closeTime,
      grossPnlPct: cost.grossPnlPct,
      netPnlPct: cost.netPnlPct,
    };
    if (isLong) longTrades.push(trade);
    else shortTrades.push(trade);
  }

  const all = [...longTrades, ...shortTrades].sort(
    (a, b) => a.entryTime - b.entryTime,
  );
  const returns = all.map((t) => t.netPnlPct);
  const netReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;

  // Sharpe (annualised): 1-hour bars, 24×365 = 8760 periods
  const meanR =
    returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const varR =
    returns.reduce((s, v) => s + (v - meanR) * (v - meanR), 0) /
    Math.max(1, returns.length);
  const stdR = Math.sqrt(varR);
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(8760) : 0;

  // Max DD on the compounded equity curve
  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    hours: stats,
    longTrades,
    shortTrades,
    netReturnPct: netReturn,
    totalTrades: all.length,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    bestHours,
    worstHours,
  };
}

/**
 * Walk-forward variant: compute hour stats on the first `trainRatio` of the
 * data, then trade on the remaining candles using those stats. This is the
 * only honest way to claim the hour-of-day edge — otherwise you're fitting
 * to the same bars you trade.
 */
export function runHourStrategyWalkForward(
  candles: Candle[],
  trainRatio = 0.5,
  config: HourStrategyConfig = DEFAULT_HOUR_STRATEGY_CONFIG,
): HourOfDayReport {
  const split = Math.floor(candles.length * trainRatio);
  const train = candles.slice(0, split);
  const test = candles.slice(split);
  const trainStats = computeHourStats(train);
  return runHourOfDayStrategy(test, trainStats, config);
}
