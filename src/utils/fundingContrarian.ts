/**
 * Funding-Extreme Contrarian (Kharat 2025, SSRN 5290137).
 *
 * When Binance Perp funding has been persistently high for multiple
 * consecutive periods AND the retail long/short ratio is crowded (>2.5),
 * the market is in overleveraged-long condition — historically reverts
 * via short-squeeze-down.
 *
 * Rule:
 *   - 3× consecutive 8h-funding > +0.05% (annualised >54%)
 *   - AND Long/Short account ratio > 2.5 at current sample
 *   - → SHORT the perp
 *   - Exit when funding crosses back below 0.01%, OR after 8h, OR -2% stop
 *
 * Mirror rule for extreme negative funding + L/S < 0.4 → LONG.
 *
 * Expected Sharpe net of costs: 0.7-1.0.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import type { FundingEvent } from "@/utils/fundingRate";
import type { LongShortRatioSample } from "@/utils/longShortRatio";

export interface FundingContrarianConfig {
  fundingPosThreshold: number; // 0.0005 = 0.05%/8h
  fundingNegThreshold: number; // 0.0005
  consecutivePeriods: number; // 3
  longShortLongCrowded: number; // 2.5 (short when above)
  longShortShortCrowded: number; // 0.4 (long when below)
  exitFundingBelow: number; // 0.0001
  holdBarsMax: number; // 8 bars on 1h = 8h
  stopPct: number; // 0.02
  costs?: CostConfig;
}

export const DEFAULT_FUNDING_CONTRARIAN_CONFIG: FundingContrarianConfig = {
  fundingPosThreshold: 0.0005,
  fundingNegThreshold: 0.0005,
  consecutivePeriods: 3,
  longShortLongCrowded: 2.5,
  longShortShortCrowded: 0.4,
  exitFundingBelow: 0.0001,
  holdBarsMax: 8,
  stopPct: 0.02,
};

export interface FundingContrarianTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggeringFunding: number;
  triggeringLsRatio: number;
  netPnlPct: number;
  exitReason: "funding-normalised" | "time" | "stop";
}

export interface FundingContrarianReport {
  trades: FundingContrarianTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
}

/** Find index of L/S sample closest to a given timestamp (<=tolMs). */
function closestLs(
  lsSamples: LongShortRatioSample[],
  ts: number,
  tolMs: number,
): LongShortRatioSample | null {
  // Binary search
  let lo = 0,
    hi = lsSamples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lsSamples[mid].time < ts) lo = mid + 1;
    else hi = mid;
  }
  const cand = lsSamples[lo];
  if (!cand) return null;
  if (Math.abs(cand.time - ts) <= tolMs) return cand;
  const prev = lsSamples[lo - 1];
  if (prev && Math.abs(prev.time - ts) <= tolMs) return prev;
  return null;
}

export function runFundingContrarianBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  lsRatios: LongShortRatioSample[],
  config: FundingContrarianConfig = DEFAULT_FUNDING_CONTRARIAN_CONFIG,
): FundingContrarianReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const sortedFunding = [...funding].sort(
    (a, b) => a.fundingTime - b.fundingTime,
  );
  const sortedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);
  const sortedLs = [...lsRatios].sort((a, b) => a.time - b.time);
  const trades: FundingContrarianTrade[] = [];
  let signalsFired = 0;

  // Track consecutive extreme funding
  let posStreak = 0;
  let negStreak = 0;

  for (let i = 0; i < sortedFunding.length; i++) {
    const ev = sortedFunding[i];
    if (ev.fundingRate > config.fundingPosThreshold) {
      posStreak++;
      negStreak = 0;
    } else if (ev.fundingRate < -config.fundingNegThreshold) {
      negStreak++;
      posStreak = 0;
    } else {
      posStreak = 0;
      negStreak = 0;
      continue;
    }

    const fireLong = negStreak >= config.consecutivePeriods;
    const fireShort = posStreak >= config.consecutivePeriods;
    if (!fireLong && !fireShort) continue;

    // Confirm with L/S ratio
    const ls = closestLs(sortedLs, ev.fundingTime, 2 * 60 * 60 * 1000);
    if (!ls) continue;
    if (fireShort && ls.longShortRatio < config.longShortLongCrowded) continue;
    if (fireLong && ls.longShortRatio > config.longShortShortCrowded) continue;

    signalsFired++;
    const direction: "long" | "short" = fireShort ? "short" : "long";

    // Entry bar: candle immediately after funding settle
    const entryIdx = sortedCandles.findIndex(
      (c) => c.openTime >= ev.fundingTime,
    );
    if (entryIdx < 0 || entryIdx + config.holdBarsMax >= sortedCandles.length)
      continue;

    const entry = sortedCandles[entryIdx].open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - config.stopPct)
        : entry * (1 + config.stopPct);

    let exitIdx = entryIdx + config.holdBarsMax;
    let exitReason: FundingContrarianTrade["exitReason"] = "time";
    let exitPrice = sortedCandles[exitIdx].close;

    // Look for funding normalisation
    for (
      let j = i + 1;
      j < sortedFunding.length &&
      sortedFunding[j].fundingTime < sortedCandles[exitIdx].closeTime;
      j++
    ) {
      const fj = sortedFunding[j];
      if (Math.abs(fj.fundingRate) < config.exitFundingBelow) {
        const barIdx = sortedCandles.findIndex(
          (c) => c.openTime >= fj.fundingTime,
        );
        if (barIdx > entryIdx) {
          exitIdx = barIdx;
          exitPrice = sortedCandles[exitIdx].open;
          exitReason = "funding-normalised";
          break;
        }
      }
    }

    // Also check stop
    for (let j = entryIdx + 1; j <= exitIdx; j++) {
      const bar = sortedCandles[j];
      if (direction === "long" && bar.low <= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
      if (direction === "short" && bar.high >= stopLevel) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
    }

    const holdHours =
      (sortedCandles[exitIdx].closeTime - sortedCandles[entryIdx].openTime) /
      (60 * 60 * 1000);
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: holdHours,
      config: costs,
    });
    trades.push({
      entryTime: sortedCandles[entryIdx].openTime,
      exitTime: sortedCandles[exitIdx].closeTime,
      direction,
      entry,
      exit: exitPrice,
      triggeringFunding: ev.fundingRate,
      triggeringLsRatio: ls.longShortRatio,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    // Reset streaks after trading
    posStreak = 0;
    negStreak = 0;
  }

  const returns = trades.map((t) => t.netPnlPct);
  const netReturn = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const varR =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(varR);
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1].exitTime - trades[0].entryTime) / 86400000
      : 30;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = std > 0 ? (m / std) * Math.sqrt(perYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades,
    signalsFired,
    netReturnPct: netReturn,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
  };
}
