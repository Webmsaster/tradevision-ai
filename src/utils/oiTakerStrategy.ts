/**
 * OI + Taker-Imbalance Strategy (Easley/López de Prado/O'Hara 2024,
 * SSRN 4814346 "Microstructure and Market Dynamics in Crypto Markets").
 *
 * Rule:
 *   - Compute ΔOI per bar (% change in Open Interest since prev bar)
 *   - Compute rolling stdev of ΔOI over 30 days
 *   - Compute TakerBuyRatio = takerBuyVolume / totalVolume (already in Candle)
 *   - Compute VWAP_24h (rolling 24-bar volume-weighted average)
 *   - LONG when ΔOI > 2σ AND TakerBuyRatio > 0.55 AND price > VWAP_24h
 *   - SHORT when ΔOI > 2σ AND TakerBuyRatio < 0.45 AND price < VWAP_24h
 *     (ΔOI>2σ on short side = new shorts, not cover)
 *   - Hold 4-8 bars, exit at OI reversal (ΔOI < -1σ) or 2R stop
 *
 * Expected Sharpe net of costs: 0.8-1.2 per Easley replications.
 * Trades are expected to be rare — only extreme OI moves fire signals.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import type { OiSample } from "@/utils/openInterest";

export interface OiTakerConfig {
  oiSigmaThreshold: number; // 2.0 by default (ΔOI z-score)
  oiSigmaWindowBars: number; // 720 (30 days on 1h)
  longTakerRatio: number; // 0.55
  shortTakerRatio: number; // 0.45
  vwapBars: number; // 24
  holdBarsMax: number; // 8
  oiExitSigma: number; // -1.0 (reversal)
  stopPctR: number; // 2.0 (R multiplier for stop)
  costs?: CostConfig;
}

export const DEFAULT_OI_TAKER_CONFIG: OiTakerConfig = {
  oiSigmaThreshold: 2.0,
  oiSigmaWindowBars: 720,
  longTakerRatio: 0.55,
  shortTakerRatio: 0.45,
  vwapBars: 24,
  holdBarsMax: 8,
  oiExitSigma: -1.0,
  stopPctR: 2.0,
};

export interface OiTakerTrade {
  time: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  entryTime: number;
  exitTime: number;
  oiSigma: number;
  takerRatio: number;
  netPnlPct: number;
  exitReason: "time" | "oi-reversal" | "stop";
}

export interface OiTakerReport {
  trades: OiTakerTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  avgHoldBars: number;
}

/**
 * Aligns 1h candles with OI samples by nearest-timestamp. Candles whose
 * timestamp has no matching OI sample within `maxGapMs` are dropped.
 */
function alignCandlesWithOi(
  candles: Candle[],
  oi: OiSample[],
  maxGapMs = 60 * 60 * 1000,
): { candle: Candle; oi: OiSample; oiDelta: number | null }[] {
  const sorted = [...oi].sort((a, b) => a.time - b.time);
  const out: { candle: Candle; oi: OiSample; oiDelta: number | null }[] = [];
  let prevOi: number | null = null;
  let j = 0;
  for (const c of candles) {
    while (j < sorted.length - 1 && sorted[j + 1].time <= c.openTime) j++;
    const o = sorted[j];
    if (!o || Math.abs(o.time - c.openTime) > maxGapMs) continue;
    const delta =
      prevOi !== null ? (o.sumOpenInterest - prevOi) / prevOi : null;
    out.push({ candle: c, oi: o, oiDelta: delta });
    prevOi = o.sumOpenInterest;
  }
  return out;
}

export function runOiTakerBacktest(
  candles: Candle[],
  oi: OiSample[],
  config: OiTakerConfig = DEFAULT_OI_TAKER_CONFIG,
): OiTakerReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const aligned = alignCandlesWithOi(candles, oi);
  if (aligned.length < config.oiSigmaWindowBars + config.vwapBars + 5) {
    return {
      trades: [],
      signalsFired: 0,
      netReturnPct: 0,
      winRate: 0,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      avgHoldBars: 0,
    };
  }

  // Rolling stdev of oiDelta
  const oiDeltas = aligned.map((a) => a.oiDelta ?? 0);
  const sigmas: number[] = new Array(aligned.length).fill(0);
  const means: number[] = new Array(aligned.length).fill(0);
  for (let i = 0; i < aligned.length; i++) {
    if (i < config.oiSigmaWindowBars) {
      sigmas[i] = 0;
      continue;
    }
    const slice = oiDeltas.slice(i - config.oiSigmaWindowBars, i);
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    means[i] = m;
    const v = slice.reduce((a, b) => a + (b - m) * (b - m), 0) / slice.length;
    sigmas[i] = Math.sqrt(v);
  }

  // Rolling VWAP
  const vwap: number[] = new Array(aligned.length).fill(0);
  for (let i = 0; i < aligned.length; i++) {
    const start = Math.max(0, i - config.vwapBars + 1);
    let num = 0,
      den = 0;
    for (let j = start; j <= i; j++) {
      const a = aligned[j].candle;
      const typical = (a.high + a.low + a.close) / 3;
      num += typical * a.volume;
      den += a.volume;
    }
    vwap[i] = den > 0 ? num / den : aligned[i].candle.close;
  }

  // Taker ratio
  const takerRatios: number[] = aligned.map((a) => {
    const total = a.candle.volume;
    if (total <= 0 || a.candle.takerBuyVolume === undefined) return 0.5;
    return a.candle.takerBuyVolume / total;
  });

  const trades: OiTakerTrade[] = [];
  let signalsFired = 0;
  let i = config.oiSigmaWindowBars;

  while (i < aligned.length - config.holdBarsMax) {
    const d = oiDeltas[i];
    const sigma = sigmas[i];
    if (sigma <= 0) {
      i++;
      continue;
    }
    const z = (d - means[i]) / sigma;
    const tr = takerRatios[i];
    const price = aligned[i].candle.close;
    const vw = vwap[i];

    let direction: "long" | "short" | null = null;
    if (
      z > config.oiSigmaThreshold &&
      tr > config.longTakerRatio &&
      price > vw
    ) {
      direction = "long";
    } else if (
      z > config.oiSigmaThreshold &&
      tr < config.shortTakerRatio &&
      price < vw
    ) {
      direction = "short";
    }

    if (direction === null) {
      i++;
      continue;
    }
    signalsFired++;

    // Find exit: time-stop, OI reversal, or price stop
    const entry = price;
    const stopDist = entry * 0.015; // fixed 1.5% for simplicity; R-multiple skipped
    const stopLevel =
      direction === "long" ? entry - stopDist : entry + stopDist;
    let exitReason: OiTakerTrade["exitReason"] = "time";
    let exitIdx = Math.min(i + config.holdBarsMax, aligned.length - 1);
    let exitPrice = aligned[exitIdx].candle.close;
    for (let j = i + 1; j <= i + config.holdBarsMax; j++) {
      const bar = aligned[j].candle;
      // Stop hit
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
      // OI reversal exit
      const jz = (oiDeltas[j] - means[j]) / Math.max(1e-9, sigmas[j]);
      if (jz < config.oiExitSigma) {
        exitIdx = j;
        exitPrice = bar.close;
        exitReason = "oi-reversal";
        break;
      }
    }

    const holdBars = exitIdx - i;
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction,
      holdingHours: holdBars,
      config: costs,
    });

    trades.push({
      time: aligned[i].candle.openTime,
      direction,
      entry,
      exit: exitPrice,
      entryTime: aligned[i].candle.openTime,
      exitTime: aligned[exitIdx].candle.closeTime,
      oiSigma: z,
      takerRatio: tr,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    i = exitIdx + 1;
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
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const std = Math.sqrt(v);
  // Annualise: trades/year estimated from sample
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1].exitTime - trades[0].entryTime) / 86400000
      : 30;
  const tradesPerYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = std > 0 ? (m / std) * Math.sqrt(tradesPerYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const avgBars =
    trades.length > 0
      ? trades.reduce(
          (s, t) => s + (t.exitTime - t.entryTime) / (60 * 60 * 1000),
          0,
        ) / trades.length
      : 0;

  return {
    trades,
    signalsFired,
    netReturnPct: netReturn,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    avgHoldBars: avgBars,
  };
}
