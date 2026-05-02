/**
 * Drawdown / Pump Fade strategy.
 *
 * Iter 38/39 hypothesis: cascade liquidations cause sharp 4-8h price moves
 * that overshoot fundamental fair value. Net long bias of crypto retail
 * means down-cascades dominate, but we test both sides symmetrically.
 *
 * Trigger: cumulative N-bar return exceeds threshold in either direction.
 *   if cumRet[i] < -dropThresholdPct: enter LONG  (fade down)
 *   if cumRet[i] > +pumpThresholdPct: enter SHORT (fade up)
 *
 * Hold for H bars or stop. Exits at next bar open of bar (i+H+1).
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface DrawdownFadeConfig {
  windowBars: number; // 4 = 4-hour cumulative move
  dropThresholdPct: number; // 0.04 = -4% drop triggers long
  pumpThresholdPct: number; // 0.04 = +4% pump triggers short
  holdBars: number; // 8
  stopPct: number; // 0.02
  costs?: CostConfig;
  longOnly?: boolean;
  shortOnly?: boolean;
}

export const DEFAULT_DD_FADE: DrawdownFadeConfig = {
  windowBars: 4,
  dropThresholdPct: 0.04,
  pumpThresholdPct: 0.04,
  holdBars: 8,
  stopPct: 0.02,
};

export interface DdFadeTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggerCumRet: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface DdFadeReport {
  trades: DdFadeTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
}

export function runDrawdownFade(
  candles: Candle[],
  cfg: DrawdownFadeConfig = DEFAULT_DD_FADE,
): DdFadeReport {
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const trades: DdFadeTrade[] = [];
  let signalsFired = 0;

  for (let i = cfg.windowBars; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const back = candles[i - cfg.windowBars];
    if (back.close <= 0) continue;
    const cumRet = (cur.close - back.close) / back.close;

    let direction: "long" | "short" | null = null;
    if (cumRet <= -cfg.dropThresholdPct && !cfg.shortOnly) direction = "long";
    else if (cumRet >= cfg.pumpThresholdPct && !cfg.longOnly)
      direction = "short";
    if (direction === null) continue;
    signalsFired++;

    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= candles.length) exitIdx = candles.length - 1;
    let exitReason: DdFadeTrade["exitReason"] = "time";
    let exitPrice = candles[exitIdx]!.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = candles[j];
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
      entryTime: entryBar.openTime,
      exitTime: candles[exitIdx]!.openTime,
      direction,
      entry,
      exit: exitPrice,
      triggerCumRet: cumRet,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    i = exitIdx;
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
  };
}
