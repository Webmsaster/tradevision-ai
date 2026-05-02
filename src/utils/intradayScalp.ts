/**
 * Intraday Scalp variant of Volume-Spike strategy.
 *
 * Iter 43: tuned for HIGH WIN RATE (target ≥60%) at the cost of profit factor.
 * Mechanism: same volume+price-z trigger as iter34, but add an asymmetric
 * take-profit that exits the trade quickly at a small gain.
 *
 *   if entry profit reaches +tpPct → exit (small win)
 *   if entry loss reaches -stopPct → exit (large loss)
 *   else exit at holdBars
 *
 * High WR design choice: tpPct < stopPct (e.g. tp=0.4%, stop=1.0%).
 * Most fast moves touch tp before stop → win count goes up.
 * BUT each win is small and each loss is large → PF can degrade.
 * Net expectancy = WR×tp - (1-WR)×stop - costs must stay > 0.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface IntradayScalpConfig {
  lookback: number;
  volMult: number;
  priceZ: number;
  tpPct: number; // 0.004 = 0.4% take profit
  stopPct: number; // 0.010 = 1.0% stop
  holdBars: number; // max bars before time exit
  costs?: CostConfig;
  mode: "fade" | "momentum";
}

export interface ScalpTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  netPnlPct: number;
  exitReason: "tp" | "stop" | "time";
}

export interface ScalpReport {
  trades: ScalpTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  tpExits: number;
  stopExits: number;
  timeExits: number;
  /** Avg bars in trade across all closed trades. */
  avgHoldBars: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]! <= 0) continue;
    r.push((closes[i]! - closes[i - 1]!) / closes[i - 1]!);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

export function runIntradayScalp(
  candles: Candle[],
  cfg: IntradayScalpConfig,
): ScalpReport {
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const trades: ScalpTrade[] = [];
  let signalsFired = 0;
  let tpExits = 0,
    stopExits = 0,
    timeExits = 0;
  let totalHoldBars = 0;

  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev!.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);
    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur!.volume / medVol;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(window.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur!.close - prev!.close) / prev!.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    signalsFired++;

    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";
    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const tpLevel =
      direction === "long" ? entry * (1 + cfg.tpPct) : entry * (1 - cfg.tpPct);
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= candles.length) exitIdx = candles.length - 1;
    let exitReason: ScalpTrade["exitReason"] = "time";
    let exitPrice = candles[exitIdx]!.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = candles[j];
      // For tie-breaking when both TP and Stop hit in same bar, use the one
      // closer to bar.open (more conservative — assumes adverse fill order).
      const tpHit =
        direction === "long" ? bar!.high >= tpLevel : bar!.low <= tpLevel;
      const stopHit =
        direction === "long" ? bar!.low <= stopLevel : bar!.high >= stopLevel;
      if (tpHit && stopHit) {
        // Worst case: assume stop fired first (more conservative)
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
      if (tpHit) {
        exitIdx = j;
        exitPrice = tpLevel;
        exitReason = "tp";
        break;
      }
      if (stopHit) {
        exitIdx = j;
        exitPrice = stopLevel;
        exitReason = "stop";
        break;
      }
    }
    if (exitReason === "tp") tpExits++;
    else if (exitReason === "stop") stopExits++;
    else timeExits++;

    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: ((exitIdx - (i + 1)) * (cfg.holdBars > 0 ? 1 : 1)) / 4, // 15m bars → /4 for hours
      config: costs,
    });
    totalHoldBars += exitIdx - (i + 1);
    trades.push({
      entryTime: entryBar.openTime,
      exitTime: candles[exitIdx]!.openTime,
      direction,
      entry,
      exit: exitPrice,
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
    tpExits,
    stopExits,
    timeExits,
    avgHoldBars: trades.length ? totalHoldBars / trades.length : 0,
  };
}
