/**
 * Funding-Rate Extreme Mean-Reversion Strategy (Intraday, Directional).
 *
 * Research: Soska et al. "Funding Rates as Predictors of Short-Term Returns
 * in Perpetual Swaps" (SSRN 4312456, 2023); Glassnode Insights "Funding
 * Squeeze Dynamics" (Mar 2024).
 *
 * Edge: when 8h-funding crosses into an extreme (e.g. > 0.1%, annualised
 * >110%), the perp is overpriced versus spot because retail is crowded
 * long. In the 4-8h window AFTER the funding payment, price reverts: perp
 * longs exit, funding-payers cover, and the mark drifts back toward fair.
 * The opposite holds for deeply-negative funding.
 *
 * THIS IS DIFFERENT FROM FUNDING CARRY. Carry is delta-neutral (long-spot +
 * short-perp). This is directional — we take a pure short (or long) on the
 * perp when funding is at an extreme, and we close inside 4-8h.
 *
 * Rule:
 *   - Entry: at bar close of the last kline BEFORE the funding event, IF
 *     funding > entryPosFunding (take short) OR funding < -entryNegFunding
 *     (take long).
 *   - Exit: after `holdBars` bars, or stop hit, or TP hit.
 *   - Fees: applied on entry + exit (taker).
 */

import type { Candle } from "@/utils/indicators";
import { sma } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import type { FundingEvent } from "@/utils/fundingRate";

export interface FundingReversionConfig {
  entryPosFunding: number; // e.g. 0.001 = 0.1% (take short above this)
  entryNegFunding: number; // e.g. 0.0008 = 0.08% (take long below -this)
  holdBars: number; // how many 15m/1h bars to hold (e.g. 8 bars on 1h = 8h)
  stopPct: number; // adverse move that triggers exit (e.g. 0.008 = 0.8%)
  targetPct: number; // favourable move that triggers exit (0 = disabled)
  costs?: CostConfig;
  /**
   * "reversion" = fade the funding extreme (classical Soska 2023 hypothesis)
   * "continuation" = trade WITH the funding direction (crowd-follower; works
   * better in trending bull markets where high funding is a trend signal)
   * "regime-aware" = continuation if price > 200-SMA, reversion otherwise
   */
  mode: "reversion" | "continuation" | "regime-aware";
  smaPeriod: number; // for regime-aware mode
}

export const DEFAULT_FUNDING_REVERSION_CONFIG: FundingReversionConfig = {
  entryPosFunding: 0.0005,
  entryNegFunding: 0.0004,
  holdBars: 8,
  stopPct: 0.01,
  targetPct: 0.006,
  mode: "regime-aware",
  smaPeriod: 200,
};

export interface ReversionTrade {
  fundingEventTime: number;
  fundingRate: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  exitReason: "time" | "stop" | "target";
  holdingHours: number;
  grossPnlPct: number;
  netPnlPct: number;
}

export interface ReversionReport {
  trades: ReversionTrade[];
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  avgHoldingHours: number;
  longCount: number;
  shortCount: number;
}

/**
 * Locate the index in `candles` whose closeTime is the last one BEFORE a
 * given timestamp. Returns -1 if none found within the array.
 */
function indexOfCandleBefore(candles: Candle[], ts: number): number {
  let lo = 0,
    hi = candles.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.closeTime < ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function runFundingReversionBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  config: FundingReversionConfig = DEFAULT_FUNDING_REVERSION_CONFIG,
): ReversionReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const sortedFunding = [...funding].sort(
    (a, b) => a.fundingTime - b.fundingTime,
  );
  const sortedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);

  const trades: ReversionTrade[] = [];
  const closes = sortedCandles.map((c) => c.close);
  const smaArr = sma(closes, config.smaPeriod);

  for (const ev of sortedFunding) {
    const isExtremePos = ev.fundingRate > config.entryPosFunding;
    const isExtremeNeg = ev.fundingRate < -config.entryNegFunding;
    if (!isExtremePos && !isExtremeNeg) continue;

    const entryIdx = indexOfCandleBefore(sortedCandles, ev.fundingTime);
    if (entryIdx < 0 || entryIdx + config.holdBars >= sortedCandles.length)
      continue;
    const entryBar = sortedCandles[entryIdx];

    // Direction depends on mode
    let direction: "long" | "short";
    if (config.mode === "continuation") {
      // Go with the crowd: high funding = longs are right → long
      direction = isExtremePos ? "long" : "short";
    } else if (config.mode === "regime-aware") {
      const smaNow = smaArr[entryIdx];
      const priceAboveSma = smaNow !== null && entryBar!.close > smaNow!;
      if (priceAboveSma) {
        // Bull regime: continuation (go with funding)
        direction = isExtremePos ? "long" : "short";
      } else {
        // Bear/range: reversion (fade the funding extreme)
        direction = isExtremePos ? "short" : "long";
      }
    } else {
      // Classical reversion
      direction = isExtremePos ? "short" : "long";
    }
    const entry = entryBar!.close;
    const entryTime = entryBar!.closeTime;

    let exitIdx = entryIdx + config.holdBars;
    let exitReason: ReversionTrade["exitReason"] = "time";

    // Walk bars forward checking stop/TP
    for (let j = entryIdx + 1; j <= entryIdx + config.holdBars; j++) {
      const bar = sortedCandles[j];
      const longPnl = (bar!.high - entry) / entry;
      const shortPnl = (entry - bar!.low) / entry;
      const adverseLong = (entry - bar!.low) / entry;
      const adverseShort = (bar!.high - entry) / entry;

      if (direction === "long") {
        if (adverseLong >= config.stopPct) {
          exitIdx = j;
          exitReason = "stop";
          break;
        }
        if (config.targetPct > 0 && longPnl >= config.targetPct) {
          exitIdx = j;
          exitReason = "target";
          break;
        }
      } else {
        if (adverseShort >= config.stopPct) {
          exitIdx = j;
          exitReason = "stop";
          break;
        }
        if (config.targetPct > 0 && shortPnl >= config.targetPct) {
          exitIdx = j;
          exitReason = "target";
          break;
        }
      }
    }

    const exitBar = sortedCandles[exitIdx];
    let exitPrice = exitBar!.close;
    if (exitReason === "stop") {
      exitPrice =
        direction === "long"
          ? entry * (1 - config.stopPct)
          : entry * (1 + config.stopPct);
    } else if (exitReason === "target") {
      exitPrice =
        direction === "long"
          ? entry * (1 + config.targetPct)
          : entry * (1 - config.targetPct);
    }
    const holdingHours =
      (exitBar!.closeTime - entryBar!.closeTime) / (60 * 60 * 1000);
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours,
      config: costs,
    });
    trades.push({
      fundingEventTime: ev.fundingTime,
      fundingRate: ev.fundingRate,
      direction,
      entry,
      exit: exitPrice,
      entryTime,
      exitTime: exitBar!.closeTime,
      exitReason,
      holdingHours,
      grossPnlPct: cost.grossPnlPct,
      netPnlPct: cost.netPnlPct,
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const netReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = returns.length > 0 ? wins / returns.length : 0;
  const grossWins = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossLosses = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  // Sharpe: we treat each trade as an observation, annualise by expected
  // trades/year (3 fundings/day × 365 × % that are extreme)
  const mean = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const variance =
    returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(variance);
  // Annualisation: estimate trades/year from sample
  const periodDays =
    returns.length > 0 && sortedFunding.length > 1
      ? (sortedFunding[sortedFunding.length - 1]!.fundingTime -
          sortedFunding[0]!.fundingTime) /
        (24 * 60 * 60 * 1000)
      : 365;
  const tradesPerYear =
    periodDays > 0 ? (returns.length / periodDays) * 365 : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(tradesPerYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1]! * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const avgHold =
    trades.reduce((s, t) => s + t.holdingHours, 0) / Math.max(1, trades.length);

  return {
    trades,
    netReturnPct: netReturn,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    avgHoldingHours: avgHold,
    longCount: trades.filter((t) => t.direction === "long").length,
    shortCount: trades.filter((t) => t.direction === "short").length,
  };
}
