/**
 * Confluence-filtered Premium Backtest.
 *
 * Iter 29: tests whether the iter25 5-star alert system's "confluence-aligned"
 * filter actually improves Coinbase Premium signal quality on historical data.
 *
 * Method:
 *   1. Get aligned (Coinbase, Binance, Bybit-spot, Bybit-perp) 1h candles.
 *   2. For each Coinbase Premium signal that fires, compute a 2-component
 *      confluence score from (Premium, Bybit Basis) at the signal bar:
 *         premComp  = clip(premium / 0.003, -1, 1)
 *         basisComp = clip(basis / 0.003, -1, 1)
 *         score     = (premComp + basisComp) / 2  in [-1, +1]
 *   3. Apply filter rules from iter25:
 *         - alignedFilter: take the trade only if score has same sign as
 *           direction AND |score| ≥ alignThreshold (0.30 = "30/100" tier)
 *         - hardOpposeFilter: skip trade if score opposes direction with
 *           |score| ≥ opposeThreshold (0.50 = "50/100" tier)
 *   4. Compare baseline (unfiltered) vs each filter variant.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface ConfluenceBacktestConfig {
  minPremiumPct: number;
  consecutiveBars: number;
  holdBars: number;
  stopPct: number;
  costs?: CostConfig;
  longOnly?: boolean;
  filter: "none" | "aligned" | "no-hard-oppose" | "aligned+no-oppose";
  alignThreshold: number; // e.g. 0.3
  opposeThreshold: number; // e.g. 0.5
}

export interface ConfluenceTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  triggerPremium: number;
  triggerBasis: number;
  triggerScore: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface ConfluenceReport {
  trades: ConfluenceTrade[];
  signalsFired: number;
  signalsTaken: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  filter: ConfluenceBacktestConfig["filter"];
}

interface AlignedRow {
  time: number;
  cb: Candle;
  bnb: Candle;
  bybSpot: Candle;
  bybPerp: Candle;
  premium: number;
  basis: number;
}

function alignAll(
  cb: Candle[],
  bnb: Candle[],
  bybSpot: Candle[],
  bybPerp: Candle[],
): AlignedRow[] {
  const bnbMap = new Map<number, Candle>();
  for (const c of bnb) bnbMap.set(c.openTime, c);
  const bybSpotMap = new Map<number, Candle>();
  for (const c of bybSpot) bybSpotMap.set(c.openTime, c);
  const bybPerpMap = new Map<number, Candle>();
  for (const c of bybPerp) bybPerpMap.set(c.openTime, c);
  const out: AlignedRow[] = [];
  for (const c of cb) {
    const b = bnbMap.get(c.openTime);
    const bs = bybSpotMap.get(c.openTime);
    const bp = bybPerpMap.get(c.openTime);
    if (!b || !bs || !bp) continue;
    const premium = b.close > 0 ? (c.close - b.close) / b.close : 0;
    const basis = bs.close > 0 ? (bp.close - bs.close) / bs.close : 0;
    out.push({
      time: c.openTime,
      cb: c,
      bnb: b,
      bybSpot: bs,
      bybPerp: bp,
      premium,
      basis,
    });
  }
  return out;
}

function clip(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function computeConfluence(premium: number, basis: number): number {
  const premComp = clip(premium / 0.003, -1, 1);
  const basisComp = clip(basis / 0.003, -1, 1);
  return (premComp + basisComp) / 2;
}

function passesFilter(
  cfg: ConfluenceBacktestConfig,
  direction: "long" | "short",
  score: number,
): boolean {
  const dirSign = direction === "long" ? 1 : -1;
  const aligned =
    Math.sign(score) === dirSign && Math.abs(score) >= cfg.alignThreshold;
  const hardOppose =
    Math.sign(score) === -dirSign && Math.abs(score) >= cfg.opposeThreshold;
  if (cfg.filter === "none") return true;
  if (cfg.filter === "aligned") return aligned;
  if (cfg.filter === "no-hard-oppose") return !hardOppose;
  if (cfg.filter === "aligned+no-oppose") return aligned && !hardOppose;
  return true;
}

export function runConfluenceBacktest(
  cb: Candle[],
  bnb: Candle[],
  bybSpot: Candle[],
  bybPerp: Candle[],
  cfg: ConfluenceBacktestConfig,
): ConfluenceReport {
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const aligned = alignAll(cb, bnb, bybSpot, bybPerp);
  const trades: ConfluenceTrade[] = [];
  let signalsFired = 0;
  let signalsTaken = 0;
  let posStreak = 0;
  let negStreak = 0;

  for (let i = 0; i < aligned.length - cfg.holdBars; i++) {
    const row = aligned[i];
    if (row.premium > cfg.minPremiumPct) {
      posStreak++;
      negStreak = 0;
    } else if (row.premium < -cfg.minPremiumPct) {
      negStreak++;
      posStreak = 0;
    } else {
      posStreak = 0;
      negStreak = 0;
      continue;
    }

    const fireLong = posStreak >= cfg.consecutiveBars;
    const fireShort = !cfg.longOnly && negStreak >= cfg.consecutiveBars;
    if (!fireLong && !fireShort) continue;
    signalsFired++;
    const direction: "long" | "short" = fireLong ? "long" : "short";
    const score = computeConfluence(row.premium, row.basis);

    if (!passesFilter(cfg, direction, score)) {
      // Filter rejected — reset streaks and skip
      posStreak = 0;
      negStreak = 0;
      continue;
    }
    signalsTaken++;

    const entryBar = aligned[i + 1];
    if (!entryBar) break;
    const entry = entryBar.bnb.open;
    const stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= aligned.length) exitIdx = aligned.length - 1;
    let exitReason: ConfluenceTrade["exitReason"] = "time";
    let exitPrice = aligned[exitIdx].bnb.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bar = aligned[j].bnb;
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
      exitTime: aligned[exitIdx].time,
      direction,
      entry,
      exit: exitPrice,
      triggerPremium: row.premium,
      triggerBasis: row.basis,
      triggerScore: score,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    posStreak = 0;
    negStreak = 0;
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
      ? (trades[trades.length - 1].exitTime - trades[0].entryTime) / 86400000
      : 30;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

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
    signalsTaken,
    netReturnPct: netRet,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    filter: cfg.filter,
  };
}
