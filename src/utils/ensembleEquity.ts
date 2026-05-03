/**
 * Multi-strategy ensemble equity-curve backtest.
 *
 * Takes the trade streams from each of the verified strategies (Champion,
 * Monday-Reversal, Funding-Carry) and simulates a portfolio that allocates
 * capital across them. Produces a single equity curve, Sharpe, and DD for
 * the combined portfolio.
 *
 * Allocation: inverse-vol × sqrt(capped Sharpe), with the same weights the
 * `portfolio.allocate()` function would compute from the historical
 * returns. Rebalanced annually (stable weights over the sample).
 *
 * The purpose is to answer: "if I traded ALL these edges together, what
 * would the portfolio look like?" Answer: smoother equity curve, lower DD
 * than any single strategy alone.
 */

import type { Candle } from "@/utils/indicators";
import { runWalkForwardHourOfDay } from "@/utils/walkForward";
import type { WalkForwardConfig } from "@/utils/walkForward";
import { runMondayReversal } from "@/utils/intradayLab";
import { runFundingCarryBacktest } from "@/utils/fundingCarry";
import type { FundingEvent } from "@/utils/fundingRate";
import { runLeadLagBacktest } from "@/utils/leadLagStrategy";
import { runFundingMinuteBacktest } from "@/utils/fundingMinuteReversion";
import { runPremiumBacktest } from "@/utils/premiumBacktest";
import {
  allocate,
  computeMetrics as computePortMetrics,
} from "@/utils/portfolio";
import type { CostConfig } from "@/utils/costModel";

export interface EnsembleInputs {
  candlesByH: Record<string, Candle[]>; // 1h candles per symbol
  fundingBySymbol: Record<string, FundingEvent[]>;
  makerCosts: CostConfig;
  takerCosts: CostConfig;
  walkForwardCfg?: Partial<WalkForwardConfig>;
  /** Optional pre-fetched Coinbase candles for Premium strategy */
  coinbaseBtc1h?: Candle[];
}

export interface DatedReturn {
  time: number;
  pnlPct: number;
  strategy: string;
}

export interface EnsembleReport {
  strategies: {
    name: string;
    returns: DatedReturn[];
    meanPct: number;
    stdDevPct: number;
    sharpe: number;
    cappedSharpe: number;
    weight: number;
  }[];
  dailyReturns: { date: string; pnlPct: number }[];
  equityCurve: { date: string; equity: number }[];
  portfolioStart: number;
  portfolioEnd: number;
  totalReturnPct: number;
  annualisedReturnPct: number;
  annualisedVolPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  winRate: number;
  totalTrades: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export async function buildEnsembleEquity(
  inputs: EnsembleInputs,
): Promise<EnsembleReport> {
  const {
    candlesByH,
    fundingBySymbol,
    makerCosts,
    takerCosts,
    walkForwardCfg = {},
  } = inputs;

  const streams: { name: string; returns: DatedReturn[] }[] = [];

  // ---- Champion walk-forward per symbol ----
  for (const [sym, candles] of Object.entries(candlesByH)) {
    const rep = runWalkForwardHourOfDay(candles, {
      trainBars: 4380,
      testBars: 720,
      topK: 3,
      bottomK: 3,
      smaPeriodBars: 24,
      longOnly: true,
      requireSignificance: false,
      costs: makerCosts,
      takerCosts,
      makerFillRate: 0.6,
      adverseSelectionBps: 3,
      skipFundingHours: true,
      fallbackToTaker: false,
      ...walkForwardCfg,
    });
    streams.push({
      name: `Champion-${sym}`,
      returns: rep.allTrades.map((t) => ({
        time: t.time,
        pnlPct: t.netPnlPct,
        strategy: `Champion-${sym}`,
      })),
    });
  }

  // ---- Monday-Reversal per symbol ----
  for (const [sym, candles] of Object.entries(candlesByH)) {
    const rep = runMondayReversal(candles, {
      weekendDropThreshold: -0.03,
      stopPct: 0.02,
      holdHours: 12,
      costs: makerCosts,
    });
    streams.push({
      name: `Monday-${sym}`,
      returns: rep.trades.map((t) => ({
        time: t.entryTime,
        pnlPct: t.netPnlPct,
        strategy: `Monday-${sym}`,
      })),
    });
  }

  // ---- Funding-Carry per symbol ----
  for (const [sym, funding] of Object.entries(fundingBySymbol)) {
    const rep = runFundingCarryBacktest(sym, funding, {
      entryThreshold: 0.0002,
      exitThreshold: 0.00005,
      consecutiveEntryPeriods: 3,
      perLegFee: makerCosts.takerFee,
    });
    streams.push({
      name: `FundingCarry-${sym}`,
      returns: rep.trades.map((t) => ({
        time: t.closeTime,
        pnlPct: t.netCarryPct,
        strategy: `FundingCarry-${sym}`,
      })),
    });
  }

  // ---- Lead-Lag: BTC→SOL (verified iter4), skip ETH (confirmed negative) ----
  const btc = candlesByH["BTCUSDT"];
  const sol = candlesByH["SOLUSDT"];
  if (btc && sol && btc.length > 100 && sol.length > 100) {
    const ll = runLeadLagBacktest(btc, sol, "SOLUSDT", {
      btcThresholdPct: 0.01,
      altMaxMovePct: 0.005,
      holdBarsMax: 3,
      targetRatioToBtc: 0.7,
      stopPctBtcReversal: 0.008,
      costs: makerCosts,
    });
    streams.push({
      name: "LeadLag-BTC→SOL",
      returns: ll.trades.map((t) => ({
        time: t.entryTime,
        pnlPct: t.netPnlPct,
        strategy: "LeadLag-BTC→SOL",
      })),
    });
  }

  // ---- Coinbase Premium: verified iter14 with 63 trades Sharpe 2.06 ----
  if (
    inputs.coinbaseBtc1h &&
    inputs.coinbaseBtc1h.length > 500 &&
    candlesByH["BTCUSDT"]
  ) {
    const rep = runPremiumBacktest(
      inputs.coinbaseBtc1h,
      candlesByH["BTCUSDT"],
      {
        minPremiumPct: 0.001,
        consecutiveBars: 2,
        holdBars: 12,
        stopPct: 0.012,
        longOnly: false,
        costs: makerCosts,
      },
    );
    streams.push({
      name: "CoinbasePremium-BTC",
      returns: rep.trades.map((t) => ({
        time: t.entryTime,
        pnlPct: t.netPnlPct,
        strategy: "CoinbasePremium-BTC",
      })),
    });
  }

  // ---- Funding-Minute-Reversion: verified on SOL (iter5), marginal on ETH ----
  for (const sym of ["SOLUSDT", "ETHUSDT"]) {
    const candles = candlesByH[sym];
    const funding = fundingBySymbol[sym];
    if (!candles || !funding) continue;
    const fm = runFundingMinuteBacktest(candles, funding, {
      minFundingAbs: 0.0005,
      entryBarsBefore: 1,
      exitBarsAfter: 1,
      stopPct: 0.01,
      costs: makerCosts,
    });
    streams.push({
      name: `FundingMinute-${sym}`,
      returns: fm.trades.map((t) => ({
        time: t.entryTime,
        pnlPct: t.netPnlPct,
        strategy: `FundingMinute-${sym}`,
      })),
    });
  }

  // ---- Allocation: portfolio weights over the whole sample ----
  const allocation = allocate(
    streams.map((s) => ({
      name: s.name,
      returnsPct: s.returns.map((r) => r.pnlPct),
      periodsPerYear: 8760 / 3, // rough — trades not every hour
    })),
  );
  const weightByName = new Map<string, number>();
  for (const r of allocation.rows) {
    weightByName.set(r.name, r.finalWeight);
  }

  // ---- Aggregate into daily portfolio returns ----
  const dayBuckets = new Map<string, number>();
  for (const s of streams) {
    const w = weightByName.get(s.name) ?? 0;
    if (w <= 0) continue;
    for (const r of s.returns) {
      const k = dayKey(r.time);
      dayBuckets.set(k, (dayBuckets.get(k) ?? 0) + r.pnlPct * w);
    }
  }
  const dailyReturns = [...dayBuckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, pnl]) => ({ date, pnlPct: pnl }));

  // ---- Equity curve + metrics ----
  const equity: { date: string; equity: number }[] = [];
  let e = 1;
  for (const d of dailyReturns) {
    e *= 1 + d.pnlPct;
    equity.push({ date: d.date, equity: e });
  }
  const firstDate = dailyReturns[0]?.date ?? "";
  const lastDate = dailyReturns[dailyReturns.length - 1]?.date ?? "";
  const totalReturn = e - 1;
  const days =
    firstDate && lastDate
      ? Math.max(
          1,
          (new Date(lastDate).getTime() - new Date(firstDate).getTime()) /
            DAY_MS,
        )
      : 1;
  const years = days / 365;
  const annualisedReturn = years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : 0;

  const returnsArr = dailyReturns.map((d) => d.pnlPct);
  const meanDaily =
    returnsArr.reduce((a, b) => a + b, 0) / Math.max(1, returnsArr.length);
  const varDaily =
    returnsArr.reduce((a, b) => a + (b - meanDaily) * (b - meanDaily), 0) /
    Math.max(1, returnsArr.length);
  const stdDaily = Math.sqrt(varDaily);
  const annualisedVol = stdDaily * Math.sqrt(365);
  const sharpe = annualisedVol > 0 ? annualisedReturn / annualisedVol : 0;

  let peak = 1;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const wins = returnsArr.filter((r) => r > 0).length;
  const winRate = returnsArr.length > 0 ? wins / returnsArr.length : 0;

  // Per-strategy summary stats
  const perStrat = streams.map((s) => {
    const m = computePortMetrics({
      name: s.name,
      returnsPct: s.returns.map((r) => r.pnlPct),
      periodsPerYear: 8760 / 3,
    });
    return {
      name: s.name,
      returns: s.returns,
      meanPct: m.meanPct,
      stdDevPct: m.stdDevPct,
      sharpe: m.sharpe,
      cappedSharpe: m.cappedSharpe,
      weight: weightByName.get(s.name) ?? 0,
    };
  });

  return {
    strategies: perStrat,
    dailyReturns,
    equityCurve: equity,
    portfolioStart: new Date(firstDate).getTime(),
    portfolioEnd: new Date(lastDate).getTime(),
    totalReturnPct: totalReturn,
    annualisedReturnPct: annualisedReturn,
    annualisedVolPct: annualisedVol,
    sharpe,
    maxDrawdownPct: maxDd,
    winRate,
    totalTrades: streams.reduce((a, s) => a + s.returns.length, 0),
  };
}
