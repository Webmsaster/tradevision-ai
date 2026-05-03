/**
 * Cross-Asset Coinbase Premium Rotation (BTC vs ETH).
 *
 * Hypothesis (iter 30): when US retail/institutions preferentially bid BTC
 * relative to ETH on Coinbase (vs Binance), they're rotating cohort
 * preference. This should predict near-term BTC/ETH ratio direction:
 *
 *   spread = (cb_btc - bnb_btc)/bnb_btc - (cb_eth - bnb_eth)/bnb_eth
 *
 * Signal:
 *   spread > +0.10% for K consecutive bars  →  LONG (BTC, short ETH)
 *   spread < -0.10% for K consecutive bars  →  SHORT (short BTC, long ETH)
 *
 * Trade: spread bet on BTC-ETH using equal $-weight legs (long_btc + short_eth).
 * Hold for H bars. Exit at next bar open of bar H+1.
 *
 * Net P&L: (entry-cost-adjusted) (btc_exit/btc_entry) - (eth_exit/eth_entry)
 *   for LONG signal, and the negative for SHORT.
 *
 * Costs: 2 legs, so 2× the single-leg cost model.
 */

import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";

export interface CohortRotationConfig {
  minSpreadPct: number; // 0.001 = 0.10%
  consecutiveBars: number; // 2
  holdBars: number; // 12
  stopPct: number; // 0.015 (on the spread leg differential)
  costs?: CostConfig;
  longOnly?: boolean;
}

export const DEFAULT_COHORT_ROTATION_CONFIG: CohortRotationConfig = {
  minSpreadPct: 0.001,
  consecutiveBars: 2,
  holdBars: 12,
  stopPct: 0.015,
  longOnly: false,
};

export interface CohortRotationTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  btcEntry: number;
  btcExit: number;
  ethEntry: number;
  ethExit: number;
  triggerSpread: number;
  netPnlPct: number;
  exitReason: "time" | "stop";
}

export interface CohortRotationReport {
  trades: CohortRotationTrade[];
  signalsFired: number;
  netReturnPct: number;
  winRate: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  spreadMean: number;
  spreadStd: number;
}

interface AlignedRow {
  time: number;
  cbBtc: Candle;
  cbEth: Candle;
  bnbBtc: Candle;
  bnbEth: Candle;
  spread: number;
}

function alignAll(
  cbBtc: Candle[],
  cbEth: Candle[],
  bnbBtc: Candle[],
  bnbEth: Candle[],
): AlignedRow[] {
  const cbEthMap = new Map<number, Candle>();
  for (const c of cbEth) cbEthMap.set(c.openTime, c);
  const bnbBtcMap = new Map<number, Candle>();
  for (const c of bnbBtc) bnbBtcMap.set(c.openTime, c);
  const bnbEthMap = new Map<number, Candle>();
  for (const c of bnbEth) bnbEthMap.set(c.openTime, c);
  const out: AlignedRow[] = [];
  for (const c of cbBtc) {
    const ce = cbEthMap.get(c.openTime);
    const bb = bnbBtcMap.get(c.openTime);
    const be = bnbEthMap.get(c.openTime);
    if (!ce || !bb || !be) continue;
    const btcPrem = bb.close > 0 ? (c.close - bb.close) / bb.close : 0;
    const ethPrem = be.close > 0 ? (ce.close - be.close) / be.close : 0;
    out.push({
      time: c.openTime,
      cbBtc: c,
      cbEth: ce,
      bnbBtc: bb,
      bnbEth: be,
      spread: btcPrem - ethPrem,
    });
  }
  return out;
}

export function runCohortRotationBacktest(
  cbBtc: Candle[],
  cbEth: Candle[],
  bnbBtc: Candle[],
  bnbEth: Candle[],
  cfg: CohortRotationConfig = DEFAULT_COHORT_ROTATION_CONFIG,
): CohortRotationReport {
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const aligned = alignAll(cbBtc, cbEth, bnbBtc, bnbEth);
  const trades: CohortRotationTrade[] = [];
  let signalsFired = 0;
  let posStreak = 0;
  let negStreak = 0;

  const spreads = aligned.map((a) => a.spread);
  const mean = spreads.reduce((s, v) => s + v, 0) / Math.max(1, spreads.length);
  const v =
    spreads.reduce((s, x) => s + (x - mean) * (x - mean), 0) /
    Math.max(1, spreads.length);
  const std = Math.sqrt(v);

  for (let i = 0; i < aligned.length - cfg.holdBars - 1; i++) {
    const row = aligned[i];
    if (row!.spread > cfg.minSpreadPct) {
      posStreak++;
      negStreak = 0;
    } else if (row!.spread < -cfg.minSpreadPct) {
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

    const entryBar = aligned[i + 1];
    if (!entryBar) break;
    const direction: "long" | "short" = fireLong ? "long" : "short";
    const btcEntry = entryBar.bnbBtc.open;
    const ethEntry = entryBar.bnbEth.open;

    let exitIdx = i + 1 + cfg.holdBars;
    if (exitIdx >= aligned.length) exitIdx = aligned.length - 1;
    let exitReason: CohortRotationTrade["exitReason"] = "time";
    let btcExit = aligned[exitIdx]!.bnbBtc.close;
    let ethExit = aligned[exitIdx]!.bnbEth.close;

    for (let j = i + 2; j <= exitIdx; j++) {
      const bbar = aligned[j]!.bnbBtc;
      const ebar = aligned[j]!.bnbEth;
      const btcRet = (bbar.close - btcEntry) / btcEntry;
      const ethRet = (ebar.close - ethEntry) / ethEntry;
      const spreadPnl =
        direction === "long" ? btcRet - ethRet : ethRet - btcRet;
      if (spreadPnl <= -cfg.stopPct) {
        exitIdx = j;
        btcExit = bbar.close;
        ethExit = ebar.close;
        exitReason = "stop";
        break;
      }
    }

    // Cost: each leg pays its own entry+exit fees
    const longLegCost = applyCosts({
      entry: direction === "long" ? btcEntry : ethEntry,
      exit: direction === "long" ? btcExit : ethExit,
      direction: "long",
      holdingHours: exitIdx - (i + 1),
      config: costs,
    });
    const shortLegCost = applyCosts({
      entry: direction === "long" ? ethEntry : btcEntry,
      exit: direction === "long" ? ethExit : btcExit,
      direction: "short",
      holdingHours: exitIdx - (i + 1),
      config: costs,
    });
    const netPnlPct = (longLegCost.netPnlPct + shortLegCost.netPnlPct) / 2;
    trades.push({
      entryTime: entryBar.time,
      exitTime: aligned[exitIdx]!.time,
      direction,
      btcEntry,
      btcExit,
      ethEntry,
      ethExit,
      triggerSpread: row!.spread,
      netPnlPct,
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
  const grossW = returns.filter((r) => r > 0).reduce((s, vv) => s + vv, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, vv) => s + vv, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : Infinity;
  const m = returns.reduce((s, vv) => s + vv, 0) / Math.max(1, returns.length);
  const v2 =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v2);
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
    spreadMean: mean,
    spreadStd: std,
  };
}
