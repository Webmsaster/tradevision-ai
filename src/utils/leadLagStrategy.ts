/**
 * BTC → ALT Lead-Lag Strategy (Aliyev et al. 2025 DSFE "High-frequency
 * GMM-VAR approach"; Sifat et al. 2019 RIBAF).
 *
 * Rule: when BTC prints a strong 1h return (>+1.5%) while ETH or SOL
 * haven't yet moved (+0.5% or less), go long the lagging alt on the
 * next bar. Exit after 1-3 hours, target = 70% of BTC's move, stop at
 * BTC reversal.
 *
 * The edge comes from retail narrative-driven flow: traders see BTC
 * pumping, buy ETH/SOL with a delay of minutes-to-hours. The HFT-level
 * lag has been arbitraged down to sub-second, but the retail-driven
 * 1-3h lag persists because it's behavioral.
 *
 * Per Aliyev 2025, works better in calm regimes (confirms why we want
 * the vol-regime gate on top of this).
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface LeadLagConfig {
  btcThresholdPct: number; // 0.015 = 1.5% BTC move triggers
  altMaxMovePct: number; // 0.005 — alt must not have moved more than this
  holdBarsMax: number; // 3 hours
  targetRatioToBtc: number; // 0.7 — alt target = BTC move × 0.7
  stopPctBtcReversal: number; // 0.008 — 0.8% reversal in BTC triggers exit
  costs?: CostConfig;
}

export const DEFAULT_LEAD_LAG_CONFIG: LeadLagConfig = {
  btcThresholdPct: 0.015,
  altMaxMovePct: 0.005,
  holdBarsMax: 3,
  targetRatioToBtc: 0.7,
  stopPctBtcReversal: 0.008,
};

export interface LeadLagTrade {
  altSymbol: string;
  triggerTime: number;
  entryTime: number;
  exitTime: number;
  btc1hReturn: number;
  altReturnAtTrigger: number;
  entry: number;
  exit: number;
  target: number;
  netPnlPct: number;
  exitReason: "time" | "target" | "btc-reversal";
}

export interface LeadLagReport {
  altSymbol: string;
  trades: LeadLagTrade[];
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
}

/** Aligns two candle series by openTime; returns arrays of matched pairs. */
function align(
  a: Candle[],
  b: Candle[],
): { time: number; a: Candle; b: Candle }[] {
  const mapB = new Map<number, Candle>();
  for (const c of b) mapB.set(c.openTime, c);
  const out: { time: number; a: Candle; b: Candle }[] = [];
  for (const c of a) {
    const bc = mapB.get(c.openTime);
    if (bc) out.push({ time: c.openTime, a: c, b: bc });
  }
  return out;
}

export function runLeadLagBacktest(
  btcCandles: Candle[],
  altCandles: Candle[],
  altSymbol: string,
  config: LeadLagConfig = DEFAULT_LEAD_LAG_CONFIG,
): LeadLagReport {
  const costs = config.costs ?? DEFAULT_COSTS;
  const pairs = align(btcCandles, altCandles);
  const trades: LeadLagTrade[] = [];

  for (let i = 1; i < pairs.length - config.holdBarsMax; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];
    const btcRet = (curr.a.close - prev.a.close) / prev.a.close;
    const altRet = (curr.b.close - prev.b.close) / prev.b.close;
    if (btcRet < config.btcThresholdPct) continue;
    if (altRet > config.altMaxMovePct) continue;

    // Enter next bar open
    const entryBar = pairs[i + 1];
    if (!entryBar) break;
    const entry = entryBar.b.open;
    const target = entry * (1 + btcRet * config.targetRatioToBtc);
    const btcEntry = entryBar.a.close;

    let exitIdx = Math.min(i + 1 + config.holdBarsMax, pairs.length - 1);
    let exitPrice = pairs[exitIdx].b.close;
    let exitReason: LeadLagTrade["exitReason"] = "time";

    for (
      let j = i + 1;
      j <= i + 1 + config.holdBarsMax && j < pairs.length;
      j++
    ) {
      const bar = pairs[j];
      // BTC reversal
      const btcFromEntry = (bar.a.close - btcEntry) / btcEntry;
      if (btcFromEntry <= -config.stopPctBtcReversal) {
        exitIdx = j;
        exitPrice = bar.b.close;
        exitReason = "btc-reversal";
        break;
      }
      // Target hit
      if (bar.b.high >= target) {
        exitIdx = j;
        exitPrice = target;
        exitReason = "target";
        break;
      }
    }

    const holdHours = (pairs[exitIdx].time - entryBar.time) / (60 * 60 * 1000);
    const cost = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: holdHours,
      config: costs,
    });
    trades.push({
      altSymbol,
      triggerTime: curr.time,
      entryTime: entryBar.time,
      exitTime: pairs[exitIdx].time,
      btc1hReturn: btcRet,
      altReturnAtTrigger: altRet,
      entry,
      exit: exitPrice,
      target,
      netPnlPct: cost.netPnlPct,
      exitReason,
    });
    // Don't trade again until exit to avoid overlapping positions
    i = exitIdx;
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
  // Annualise from sample
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
    altSymbol,
    trades,
    netReturnPct: netReturn,
    winRate,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
  };
}
