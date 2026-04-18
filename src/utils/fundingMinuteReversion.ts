/**
 * Funding-Settlement-Minute Mean-Reversion (Inan 2025, SSRN 5576424).
 *
 * Binance settles perpetual funding 3× daily at 00:00, 08:00, 16:00 UTC.
 * In the hour leading up to settlement, longs who hold a big funding bill
 * pre-sell to hedge — this creates short-term selling pressure that then
 * reverts in the 15-60 minutes after settlement.
 *
 * Rule: 1h before funding settle, if |funding| > 0.05%:
 *   - funding positive (longs pay shorts): long price will drift DOWN
 *     into settle (hedge-selling), then REVERT UP post-settle → long trade
 *   - funding negative (shorts pay longs): price drifts UP into settle
 *     (hedge-buying), then REVERT DOWN post-settle → short trade
 *
 * Haltedauer: enter 1h before settle, exit 1h after. Stop at -1% adverse.
 * Works because carry-arbitrage compressed the main basis profit but left
 * the pre-settle overshoot behavior intact.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import type { FundingEvent } from "@/utils/fundingRate";

export interface FundingMinuteConfig {
  minFundingAbs: number; // 0.0005 (0.05%/8h) trigger
  entryBarsBefore: number; // enter N bars before settle (default 1 on 1h)
  exitBarsAfter: number; // exit N bars after settle (default 1 on 1h)
  stopPct: number; // 0.01 = 1%
  costs?: CostConfig;
}

export const DEFAULT_FUNDING_MINUTE_CONFIG: FundingMinuteConfig = {
  minFundingAbs: 0.0005,
  entryBarsBefore: 1,
  exitBarsAfter: 1,
  stopPct: 0.01,
};

export interface FundingMinuteTrade {
  settleTime: number;
  fundingRate: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface FundingMinuteReport {
  trades: FundingMinuteTrade[];
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  signalsFired: number;
}

function indexOfCandleAt(
  candles: Candle[],
  ts: number,
  tolMs = 60 * 60 * 1000,
): number {
  // Binary search to closest closeTime
  let lo = 0,
    hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].closeTime < ts) lo = mid + 1;
    else hi = mid;
  }
  return Math.abs(candles[lo]?.closeTime - ts) <= tolMs ? lo : -1;
}

export function runFundingMinuteBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  config: FundingMinuteConfig = DEFAULT_FUNDING_MINUTE_CONFIG,
): FundingMinuteReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const sortedFunding = [...funding].sort(
    (a, b) => a.fundingTime - b.fundingTime,
  );
  const sortedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);
  const trades: FundingMinuteTrade[] = [];
  let signalsFired = 0;

  for (const ev of sortedFunding) {
    if (Math.abs(ev.fundingRate) < config.minFundingAbs) continue;
    signalsFired++;

    const settleIdx = indexOfCandleAt(sortedCandles, ev.fundingTime);
    if (settleIdx < 0) continue;
    const entryIdx = settleIdx - config.entryBarsBefore;
    const exitIdx = settleIdx + config.exitBarsAfter;
    if (entryIdx < 0 || exitIdx >= sortedCandles.length) continue;

    const entryBar = sortedCandles[entryIdx];
    const exitBar = sortedCandles[exitIdx];
    // Funding > 0 → fade longs → short pre-settle (expecting price drop into settle)
    // wait that's the OPPOSITE of what we want. Let me re-read.
    // Inan 2025: pre-settle longs hedge-SELL → price drops → post-settle RECOVERY
    // So we LONG pre-settle (buy the hedge-dip) and exit post-settle recovery
    // Direction depends on funding sign:
    //   positive funding (longs pay) → longs sell pre-settle → we LONG
    //   negative funding (shorts pay) → shorts buy pre-settle → we SHORT
    const direction: "long" | "short" = ev.fundingRate > 0 ? "long" : "short";

    const entry = entryBar.close;
    const stopLevel =
      direction === "long"
        ? entry * (1 - config.stopPct)
        : entry * (1 + config.stopPct);

    let exitReason: FundingMinuteTrade["exitReason"] = "time";
    let actualExitIdx = exitIdx;
    let exitPrice = exitBar.close;
    for (let j = entryIdx + 1; j <= exitIdx; j++) {
      const bar = sortedCandles[j];
      if (direction === "long" && bar.low <= stopLevel) {
        actualExitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
      if (direction === "short" && bar.high >= stopLevel) {
        actualExitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
    }

    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: config.entryBarsBefore + config.exitBarsAfter,
      config: costs,
    });
    trades.push({
      settleTime: ev.fundingTime,
      fundingRate: ev.fundingRate,
      direction,
      entry,
      exit: exitPrice,
      entryTime: entryBar.closeTime,
      exitTime: sortedCandles[actualExitIdx].closeTime,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
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
    netReturnPct: netReturn,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    signalsFired,
  };
}
