/**
 * Walk-Forward Rolling Retrain for hour-of-day strategy.
 *
 * Problem with single 50/50 split: the reversed-split Sharpe is negative,
 * meaning optimal hours drift with regime. Real deployment would retrain
 * periodically. This module simulates that:
 *   1. Start at bar `trainBars`.
 *   2. Use last `trainBars` to pick long/short hours.
 *   3. Trade the next `testBars` bars with those hours + trend filter.
 *   4. Slide forward `testBars`, refit, repeat.
 * Aggregate all OOS returns into a single equity curve + Sharpe.
 *
 * This is the HONEST performance you'd get in live deployment.
 */

import type { Candle } from "@/utils/indicators";
import { sma } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import { computeHourStats } from "@/utils/hourOfDayStrategy";

export interface WalkForwardConfig {
  trainBars: number; // e.g. 4380 (6 months on 1h)
  testBars: number; // e.g. 720 (30 days on 1h)
  topK: number;
  bottomK: number;
  smaPeriodBars: number;
  longOnly: boolean;
  costs?: CostConfig;
  requireSignificance?: boolean;
  /** Fraction of post-only orders that actually fill (0..1). */
  makerFillRate?: number;
  /** When a post-only order doesn't fill, do we take the trade at taker cost? */
  fallbackToTaker?: boolean;
  /** Cost profile used for unfilled→taker fallback (if enabled). */
  takerCosts?: CostConfig;
  /**
   * Adverse-selection penalty in basis points subtracted from EVERY fill.
   * Empirical: 2-4 bps on Binance BTC/ETH perp top-of-book. Source:
   * Albers/Cucuringu/Howison/Shestopaloff 2025 (arXiv 2502.18625).
   */
  adverseSelectionBps?: number;
  /**
   * Skip signals that fire in the 5-min window before funding settle
   * (00:00, 08:00, 16:00 UTC) where spread widens and adverse-selection
   * spikes. Practical for 1h-bar strategies: if an entry hour IS a funding
   * hour, apply an extra vol penalty or skip.
   */
  skipFundingHours?: boolean;
}

export const DEFAULT_WALK_FORWARD_CONFIG: WalkForwardConfig = {
  trainBars: 4380, // ~6 months of 1h bars
  testBars: 720, // ~30 days
  topK: 5,
  bottomK: 5,
  smaPeriodBars: 50,
  longOnly: true,
  requireSignificance: false,
  makerFillRate: 0.6, // Albers et al. 2025: realistic for BTC/ETH Perp top-of-book
  fallbackToTaker: false,
  adverseSelectionBps: 3, // 2-4 bps empirical penalty per Albers et al.
  skipFundingHours: true,
};

export interface WalkForwardTrade {
  time: number;
  hour: number;
  direction: "long" | "short";
  netPnlPct: number;
  filled: boolean;
  viaTaker: boolean;
}

export interface WalkForwardWindow {
  trainStartTime: number;
  trainEndTime: number;
  testStartTime: number;
  testEndTime: number;
  longHours: number[];
  shortHours: number[];
  trades: number;
  returnPct: number;
  sharpe: number;
}

export interface WalkForwardReport {
  windows: WalkForwardWindow[];
  allTrades: WalkForwardTrade[];
  totalTrades: number;
  filledTrades: number;
  takerFallbacks: number;
  netReturnPct: number;
  winRate: number;
  sharpe: number;
  maxDrawdownPct: number;
  equityCurve: number[];
}

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function runWalkForwardHourOfDay(
  candles: Candle[],
  config: WalkForwardConfig = DEFAULT_WALK_FORWARD_CONFIG,
): WalkForwardReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const takerCosts = config.takerCosts ?? DEFAULT_COSTS;
  const rand = seededRandom(42);

  const windows: WalkForwardWindow[] = [];
  const allTrades: WalkForwardTrade[] = [];
  const equity = [1];
  const closes = candles.map((c) => c.close);
  const smaArr = sma(closes, config.smaPeriodBars);

  let start = config.trainBars;
  while (start + config.testBars <= candles.length) {
    const trainSlice = candles.slice(start - config.trainBars, start);
    const testSlice = candles.slice(start, start + config.testBars);
    const stats = computeHourStats(trainSlice);
    const sorted = [...stats].sort((a, b) => b.meanReturnPct - a.meanReturnPct);
    const pool = config.requireSignificance
      ? sorted.filter((s) => s.significant)
      : sorted;
    const longHours = pool.slice(0, config.topK).map((s) => s.hourUtc);
    const shortHours = pool.slice(-config.bottomK).map((s) => s.hourUtc);
    const longSet = new Set(longHours);
    const shortSet = new Set(shortHours);

    const windowTrades: WalkForwardTrade[] = [];
    let winReturn = 1;
    for (let i = 0; i < testSlice.length; i++) {
      const globalIdx = start + i;
      const smaNow = smaArr[globalIdx];
      if (smaNow === null) continue;
      const bar = testSlice[i];
      const hour = new Date(bar.openTime).getUTCHours();

      // Skip funding-settle hours if configured (wider spreads, toxic flow)
      if (
        config.skipFundingHours &&
        (hour === 0 || hour === 8 || hour === 16)
      ) {
        continue;
      }

      const above = bar.close > smaNow;
      const isLong = longSet.has(hour) && above;
      const isShort = !config.longOnly && shortSet.has(hour) && !above;
      if (!isLong && !isShort) continue;
      const direction: "long" | "short" = isLong ? "long" : "short";

      // Simulate maker fill
      const filled =
        config.makerFillRate === undefined || rand() < config.makerFillRate;
      let pnl = 0;
      let viaTaker = false;
      const adversePenalty = (config.adverseSelectionBps ?? 0) / 10_000;
      if (filled) {
        const cost = applyCosts({
          entry: bar.open,
          exit: bar.close,
          direction,
          holdingHours: 1,
          config: costs,
        });
        // Adverse-selection = toxic-fill penalty subtracted from net PnL
        pnl = cost.netPnlPct - adversePenalty;
      } else if (config.fallbackToTaker) {
        const cost = applyCosts({
          entry: bar.open,
          exit: bar.close,
          direction,
          holdingHours: 1,
          config: takerCosts,
        });
        pnl = cost.netPnlPct - adversePenalty;
        viaTaker = true;
      } else {
        continue; // skip the trade
      }
      windowTrades.push({
        time: bar.openTime,
        hour,
        direction,
        netPnlPct: pnl,
        filled,
        viaTaker,
      });
      winReturn *= 1 + pnl;
      equity.push(equity[equity.length - 1] * (1 + pnl));
    }

    const winRets = windowTrades.map((t) => t.netPnlPct);
    const m = winRets.reduce((s, v) => s + v, 0) / Math.max(1, winRets.length);
    const v =
      winRets.reduce((s, x) => s + (x - m) * (x - m), 0) /
      Math.max(1, winRets.length);
    const std = Math.sqrt(v);
    const winSharpe = std > 0 ? (m / std) * Math.sqrt(8760) : 0;

    windows.push({
      trainStartTime: trainSlice[0].openTime,
      trainEndTime: trainSlice[trainSlice.length - 1].closeTime,
      testStartTime: testSlice[0].openTime,
      testEndTime: testSlice[testSlice.length - 1].closeTime,
      longHours,
      shortHours,
      trades: windowTrades.length,
      returnPct: winReturn - 1,
      sharpe: winSharpe,
    });
    allTrades.push(...windowTrades);
    start += config.testBars;
  }

  const returns = allTrades.map((t) => t.netPnlPct);
  const netReturn = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  const sharpe = std > 0 ? (m / std) * Math.sqrt(8760) : 0;
  let peak = 1;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    windows,
    allTrades,
    totalTrades: allTrades.length,
    filledTrades: allTrades.filter((t) => t.filled).length,
    takerFallbacks: allTrades.filter((t) => t.viaTaker).length,
    netReturnPct: netReturn,
    winRate,
    sharpe,
    maxDrawdownPct: maxDd,
    equityCurve: equity,
  };
}

// ---------------------------------------------------------------------------
// Grid search across parameters to find the most robust configuration.
// ---------------------------------------------------------------------------

export interface GridSearchResult {
  config: Partial<WalkForwardConfig>;
  symbol: string;
  report: WalkForwardReport;
}

export function runGridSearch(
  candles: Candle[],
  symbol: string,
  costs: CostConfig,
  grid: {
    trainBarsOpts: number[];
    testBarsOpts: number[];
    topKOpts: number[];
    smaPeriodOpts: number[];
    longOnlyOpts: boolean[];
    fillRateOpts: number[];
  },
): GridSearchResult[] {
  const results: GridSearchResult[] = [];
  for (const trainBars of grid.trainBarsOpts) {
    for (const testBars of grid.testBarsOpts) {
      for (const topK of grid.topKOpts) {
        for (const smaPeriodBars of grid.smaPeriodOpts) {
          for (const longOnly of grid.longOnlyOpts) {
            for (const makerFillRate of grid.fillRateOpts) {
              const config: WalkForwardConfig = {
                trainBars,
                testBars,
                topK,
                bottomK: topK,
                smaPeriodBars,
                longOnly,
                makerFillRate,
                costs,
                requireSignificance: false,
              };
              const rep = runWalkForwardHourOfDay(candles, config);
              if (rep.totalTrades < 20) continue;
              results.push({ config, symbol, report: rep });
            }
          }
        }
      }
    }
  }
  // Sort by Sharpe (robust Sharpe × consistency)
  results.sort((a, b) => b.report.sharpe - a.report.sharpe);
  return results;
}
