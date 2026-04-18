/**
 * Fast client-side strategy-health check.
 *
 * The full walk-forward backtest runs 20+ windows and can take 500-1000ms
 * per symbol. That's too slow for a 5-min UI refresh across 3 symbols.
 *
 * This module computes a fast PROXY for strategy health:
 *   - Use the full candle series ONCE to find hour-of-day stats.
 *   - Walk only the LAST N trades (e.g. last 90 bars that satisfy the
 *     strategy's entry condition).
 *   - Compare recent Sharpe to all-candles-in-sample Sharpe.
 *
 * It's not as rigorous as the full rolling retrain, but it runs in <50ms
 * and gives a usable HEALTHY/WATCH/PAUSE signal for the UI.
 */

import type { Candle } from "@/utils/indicators";
import { sma } from "@/utils/indicators";
import { computeHourStats } from "@/utils/hourOfDayStrategy";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface FastHealthInput {
  candles: Candle[];
  topK?: number;
  smaPeriodBars?: number;
  costs?: CostConfig;
  recentTrades?: number;
  longOnly?: boolean;
  adverseSelectionBps?: number;
}

export interface FastHealthResult {
  lifetimeSharpe: number;
  recentSharpe: number;
  ratio: number;
  status: "healthy" | "watch" | "pause";
  lifetimeN: number;
  recentN: number;
}

export function fastHealthCheck(input: FastHealthInput): FastHealthResult {
  const {
    candles,
    topK = 3,
    smaPeriodBars = 24,
    costs = DEFAULT_COSTS,
    recentTrades = 30,
    longOnly = true,
    adverseSelectionBps = 3,
  } = input;

  if (candles.length < 200) {
    return {
      lifetimeSharpe: 0,
      recentSharpe: 0,
      ratio: 0,
      status: "pause",
      lifetimeN: 0,
      recentN: 0,
    };
  }

  const stats = computeHourStats(candles);
  const sorted = [...stats].sort((a, b) => b.meanReturnPct - a.meanReturnPct);
  const longHours = new Set(sorted.slice(0, topK).map((s) => s.hourUtc));
  const shortHours = new Set(
    longOnly ? [] : sorted.slice(-topK).map((s) => s.hourUtc),
  );

  const closes = candles.map((c) => c.close);
  const smaArr = sma(closes, smaPeriodBars);
  const returns: number[] = [];
  const adverse = adverseSelectionBps / 10_000;

  for (let i = smaPeriodBars; i < candles.length; i++) {
    const smaNow = smaArr[i];
    if (smaNow === null) continue;
    const bar = candles[i];
    const hour = new Date(bar.openTime).getUTCHours();
    if (hour === 0 || hour === 8 || hour === 16) continue; // skip funding hours
    const above = bar.close > smaNow;
    const isLong = longHours.has(hour) && above;
    const isShort = shortHours.has(hour) && !above;
    if (!isLong && !isShort) continue;
    const direction: "long" | "short" = isLong ? "long" : "short";
    const cost = applyCosts({
      entry: bar.open,
      exit: bar.close,
      direction,
      holdingHours: 1,
      config: costs,
    });
    returns.push(cost.netPnlPct - adverse);
  }

  function sharpe(arr: number[]): number {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
    const sd = Math.sqrt(v);
    return sd > 0 ? (m / sd) * Math.sqrt(8760) : 0;
  }

  const lifetime = sharpe(returns);
  const recent = sharpe(returns.slice(-recentTrades));
  const ratio = lifetime > 0 ? recent / lifetime : 0;
  let status: FastHealthResult["status"] = "healthy";
  if (recent < 0 || ratio < 0.3) status = "pause";
  else if (ratio < 0.8) status = "watch";

  return {
    lifetimeSharpe: lifetime,
    recentSharpe: recent,
    ratio,
    status,
    lifetimeN: returns.length,
    recentN: Math.min(recentTrades, returns.length),
  };
}
