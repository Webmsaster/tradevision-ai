/**
 * Coinbase-Binance Premium Backtest.
 *
 * Signal: 2× consecutive 1h bars where (coinbase_close - binance_close) /
 * binance_close > threshold → enter LONG BTC at next bar open.
 * Exit after holdBars or stop hit. Mirror for negative premium → SHORT.
 *
 * Theoretical basis: persistent premium = one-sided flow. Retail follow-
 * through means the trend extends for 12-24h. Korea premium study (Choi
 * 2022) validates this on ~3y of data.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface PremiumBacktestConfig {
  minPremiumPct: number; // 0.0015 = 0.15%
  consecutiveBars: number; // 2
  holdBars: number; // 24 = 1 day
  stopPct: number; // 0.015
  costs?: CostConfig;
  longOnly?: boolean;
}

export const DEFAULT_PREMIUM_BACKTEST_CONFIG: PremiumBacktestConfig = {
  minPremiumPct: 0.0015,
  consecutiveBars: 2,
  holdBars: 24,
  stopPct: 0.015,
  longOnly: true,
};

export interface PremiumTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggerPremium: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface PremiumReport {
  trades: PremiumTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  premiumMean: number;
  premiumStd: number;
  premiumMax: number;
  premiumMin: number;
}

/** Align Coinbase + Binance candles by openTime (both 1h). */
function alignPair(
  cb: Candle[],
  bnb: Candle[],
): { time: number; cb: Candle; bnb: Candle; premium: number }[] {
  const map = new Map<number, Candle>();
  for (const c of bnb) map.set(c.openTime, c);
  const out: { time: number; cb: Candle; bnb: Candle; premium: number }[] = [];
  for (const c of cb) {
    const b = map.get(c.openTime);
    if (!b) continue;
    const prem = b.close > 0 ? (c.close - b.close) / b.close : 0;
    out.push({ time: c.openTime, cb: c, bnb: b, premium: prem });
  }
  return out;
}

export function runPremiumBacktest(
  coinbase: Candle[],
  binance: Candle[],
  config: PremiumBacktestConfig = DEFAULT_PREMIUM_BACKTEST_CONFIG,
): PremiumReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const aligned = alignPair(coinbase, binance);
  const trades: PremiumTrade[] = [];
  let signalsFired = 0;
  let posStreak = 0;
  let negStreak = 0;

  const premiums = aligned.map((a) => a.premium);
  const mean =
    premiums.reduce((a, b) => a + b, 0) / Math.max(1, premiums.length);
  const std = Math.sqrt(
    premiums.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      Math.max(1, premiums.length),
  );

  for (let i = 0; i < aligned.length - config.holdBars; i++) {
    const row = aligned[i];
    if (row!.premium > config.minPremiumPct) {
      posStreak++;
      negStreak = 0;
    } else if (row!.premium < -config.minPremiumPct) {
      negStreak++;
      posStreak = 0;
    } else {
      posStreak = 0;
      negStreak = 0;
      continue;
    }

    const fireLong = posStreak >= config.consecutiveBars;
    const fireShort = !config.longOnly && negStreak >= config.consecutiveBars;
    if (!fireLong && !fireShort) continue;
    signalsFired++;

    // Entry: next bar open (use Binance price — that's what we trade)
    const entryBar = aligned[i + 1];
    if (!entryBar) break;
    const direction: "long" | "short" = fireLong ? "long" : "short";
    const entry = entryBar.bnb.open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - config.stopPct)
        : entry * (1 + config.stopPct);

    let exitIdx = i + 1 + config.holdBars;
    if (exitIdx >= aligned.length) exitIdx = aligned.length - 1;
    let exitReason: PremiumTrade["exitReason"] = "time";
    let exitPrice = aligned[exitIdx]!.bnb.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = aligned[j]!.bnb;
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

    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: exitIdx - (i + 1),
      config: costs,
    });
    trades.push({
      entryTime: entryBar.time,
      exitTime: aligned[exitIdx]!.time,
      direction,
      entry,
      exit: exitPrice,
      triggerPremium: row!.premium,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    posStreak = 0;
    negStreak = 0;
    i = exitIdx; // skip ahead past the holding window
  }

  const returns = trades.map((t) => t.netPnlPct);
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
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
  const sd = Math.sqrt(v);
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1]!.exitTime - trades[0]!.entryTime) / 86400000
      : 30;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

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
    signalsFired,
    netReturnPct: netRet,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    premiumMean: mean,
    premiumStd: std,
    premiumMax: Math.max(...premiums),
    premiumMin: Math.min(...premiums),
  };
}
