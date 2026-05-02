/**
 * FTMO Donchian Ensemble Engine — based on "Catching Crypto Trends" (Zarattini et al, 2025).
 *
 * Strategy:
 * - ENSEMBLE of multiple Donchian Channel breakouts with different lookbacks
 * - LONG when price breaks above multiple upper bands (majority vote)
 * - SHORT when price breaks below multiple lower bands
 * - ATR-based volatility-adaptive position sizing
 * - Trail stops with chandelier (lower-of-recent-high - N×ATR)
 *
 * Different from V5 (EMA crossover) and from MR engine (RSI mean reversion).
 */
import type { Candle } from "./indicators";
import { atr } from "./indicators";

export interface DonchianAssetConfig {
  symbol: string;
  sourceSymbol: string;
  costBp: number;
  slippageBp: number;
  swapBpPerDay: number;
  riskFrac: number;
  lookbacks: number[]; // e.g., [10, 20, 30, 40, 50] — votes across all
  minVotes: number; // minimum number of lookbacks confirming (default = ceil(lookbacks.length / 2))
  atrPeriod: number;
  atrStopMult: number; // chandelier multiplier
  tpAtrMult: number; // TP at N × ATR profit
  holdBars: number;
  allowLong: boolean;
  allowShort: boolean;
}

export interface DonchianEngineConfig {
  assets: DonchianAssetConfig[];
  timeframe: "30m" | "1h" | "2h" | "4h";
  leverage: number;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  maxDays: number;
  pauseAtTargetReached: boolean;
  liveCaps?: { maxStopPct: number; maxRiskFrac: number };
  maxConcurrentTrades: number;
  allowedHoursUtc?: number[];
}

interface OpenPosition {
  asset: string;
  symbol: string;
  direction: "long" | "short";
  entryBar: number;
  entryPrice: number;
  stopPrice: number;
  tpPrice: number;
  highWaterMark: number;
  lowWaterMark: number;
  riskFrac: number;
  costBp: number;
  swapBpPerDay: number;
  atrStopMult: number;
}

interface ClosedTrade {
  asset: string;
  direction: "long" | "short";
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  reason: "tp" | "sl" | "trail" | "max_hold" | "force_close";
  pnlPct: number;
  effPnl: number;
  day: number;
}

export interface DonchianEngineResult {
  passed: boolean;
  reason: "passed" | "total_loss" | "daily_loss" | "timeout";
  finalEquityPct: number;
  maxDrawdown: number;
  trades: ClosedTrade[];
  tradingDays: number;
}

const BARS_PER_DAY: Record<string, number> = {
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

/** Compute Donchian channel bands for given lookbacks. Returns upper/lower bands at each bar. */
function donchianBands(
  candles: Candle[],
  lookback: number,
): { upper: number[]; lower: number[] } {
  const n = candles.length;
  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);
  for (let i = lookback; i < n; i++) {
    let hi = -Infinity,
      lo = Infinity;
    for (let j = i - lookback; j < i; j++) {
      if (candles[j]!.high > hi) hi = candles[j]!.high;
      if (candles[j]!.low < lo) lo = candles[j]!.low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Count how many lookbacks confirm a long/short breakout at current bar */
function ensembleVote(
  candle: Candle,
  allBands: { upper: number[]; lower: number[] }[],
  bar: number,
): { longVotes: number; shortVotes: number } {
  let longVotes = 0;
  let shortVotes = 0;
  for (const bands of allBands) {
    if (Number.isFinite(bands.upper[bar]) && candle.close > bands.upper[bar]!)
      longVotes++;
    if (Number.isFinite(bands.lower[bar]) && candle.close < bands.lower[bar]!)
      shortVotes++;
  }
  return { longVotes, shortVotes };
}

export function runDonchianEngine(
  candleData: Record<string, Candle[]>,
  cfg: DonchianEngineConfig,
): DonchianEngineResult {
  const symbols = cfg.assets.map((a) => a.sourceSymbol);
  const n = Math.min(...symbols.map((s) => candleData[s]?.length ?? 0));
  if (n === 0)
    return {
      passed: false,
      reason: "timeout",
      finalEquityPct: 0,
      maxDrawdown: 0,
      trades: [],
      tradingDays: 0,
    };
  const barsPerDay = BARS_PER_DAY[cfg.timeframe];
  const maxBars = Math.min(n, cfg.maxDays * barsPerDay!);

  // Pre-compute Donchian bands and ATR for each asset
  const bandsData: Record<string, { upper: number[]; lower: number[] }[]> = {};
  const atrData: Record<string, (number | null)[]> = {};
  for (const a of cfg.assets) {
    const c = candleData[a.sourceSymbol]!.slice(0, maxBars);
    bandsData[a.sourceSymbol] = a.lookbacks.map((lb) => donchianBands(c, lb));
    atrData[a.sourceSymbol] = atr(c, a.atrPeriod);
  }

  // Apply live caps
  const cappedAssets = cfg.assets.map((a) => ({
    ...a,
    riskFrac: cfg.liveCaps
      ? Math.min(a.riskFrac, cfg.liveCaps.maxRiskFrac)
      : a.riskFrac,
  }));

  let equity = 1.0;
  let peakEquity = 1.0;
  let maxDD = 0;
  let dailyStartEquity = 1.0;
  let lastDayIndex = -1;
  let frozenForDay = false;
  let pausedAfterTarget = false;
  let targetReached = false;

  const open: OpenPosition[] = [];
  const closed: ClosedTrade[] = [];
  const tradingDaysSet = new Set<number>();

  for (let bar = 1; bar < maxBars; bar++) {
    const dayIndex = Math.floor(bar / barsPerDay!);
    if (dayIndex !== lastDayIndex) {
      dailyStartEquity = equity;
      frozenForDay = false;
      lastDayIndex = dayIndex;
    }

    if (pausedAfterTarget) continue;

    if (equity / dailyStartEquity - 1 <= -cfg.maxDailyLoss) {
      for (const pos of open) {
        const exitPrice = candleData[pos.symbol]![bar]?.close ?? pos.entryPrice;
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const effPnl = rawPnl * cfg.leverage * pos.riskFrac;
        equity += effPnl;
        closed.push({
          asset: pos.asset,
          direction: pos.direction,
          entryBar: pos.entryBar,
          exitBar: bar,
          entryPrice: pos.entryPrice,
          exitPrice,
          reason: "force_close",
          pnlPct: rawPnl,
          effPnl,
          day: dayIndex,
        });
      }
      open.length = 0;
      frozenForDay = true;
      continue;
    }
    if (frozenForDay) continue;

    if (equity - 1 <= -cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDD,
        trades: closed,
        tradingDays: tradingDaysSet.size,
      };
    }

    if (cfg.pauseAtTargetReached && equity - 1 >= cfg.profitTarget) {
      targetReached = true;
      for (const pos of open) {
        const exitPrice = candleData[pos.symbol]![bar]?.close ?? pos.entryPrice;
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const effPnl = rawPnl * cfg.leverage * pos.riskFrac;
        equity += effPnl;
        closed.push({
          asset: pos.asset,
          direction: pos.direction,
          entryBar: pos.entryBar,
          exitBar: bar,
          entryPrice: pos.entryPrice,
          exitPrice,
          reason: "force_close",
          pnlPct: rawPnl,
          effPnl,
          day: dayIndex,
        });
      }
      open.length = 0;
      pausedAfterTarget = true;
      continue;
    }

    // Manage open positions: chandelier trail, TP, SL, max_hold
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const candle = candleData[pos!.symbol]![bar];
      const asset = cappedAssets.find((a) => a.symbol === pos!.asset)!;
      if (!candle) continue;
      let exitReason: ClosedTrade["reason"] | null = null;
      let exitPrice = candle.close;

      // Update high/low water marks for chandelier
      if (pos!.direction === "long" && candle.high > pos!.highWaterMark)
        pos!.highWaterMark = candle.high;
      if (pos!.direction === "short" && candle.low < pos!.lowWaterMark)
        pos!.lowWaterMark = candle.low;

      // Update trailing stop with chandelier
      const a = atrData[pos!.symbol]![bar];
      if (a !== null && Number.isFinite(a)) {
        const trail =
          pos!.direction === "long"
            ? pos!.highWaterMark - a! * pos!.atrStopMult
            : pos!.lowWaterMark + a! * pos!.atrStopMult;
        if (pos!.direction === "long" && trail > pos!.stopPrice)
          pos!.stopPrice = trail;
        if (pos!.direction === "short" && trail < pos!.stopPrice)
          pos!.stopPrice = trail;
      }

      if (pos!.direction === "long") {
        if (candle.low <= pos!.stopPrice) {
          exitReason = "trail";
          exitPrice = pos!.stopPrice;
        } else if (candle.high >= pos!.tpPrice) {
          exitReason = "tp";
          exitPrice = pos!.tpPrice;
        } else if (bar - pos!.entryBar >= asset.holdBars) {
          exitReason = "max_hold";
          exitPrice = candle.close;
        }
      } else {
        if (candle.high >= pos!.stopPrice) {
          exitReason = "trail";
          exitPrice = pos!.stopPrice;
        } else if (candle.low <= pos!.tpPrice) {
          exitReason = "tp";
          exitPrice = pos!.tpPrice;
        } else if (bar - pos!.entryBar >= asset.holdBars) {
          exitReason = "max_hold";
          exitPrice = candle.close;
        }
      }

      if (exitReason) {
        const rawPnl =
          pos!.direction === "long"
            ? (exitPrice - pos!.entryPrice) / pos!.entryPrice
            : (pos!.entryPrice - exitPrice) / pos!.entryPrice;
        const totalCostFrac = ((pos!.costBp + 8) / 10000) * 2;
        const adjPnl = rawPnl - totalCostFrac;
        const effPnl = adjPnl * cfg.leverage * pos!.riskFrac;
        equity += effPnl;
        closed.push({
          asset: pos!.asset,
          direction: pos!.direction,
          entryBar: pos!.entryBar,
          exitBar: bar,
          entryPrice: pos!.entryPrice,
          exitPrice,
          reason: exitReason,
          pnlPct: rawPnl,
          effPnl,
          day: dayIndex,
        });
        open.splice(i, 1);
      }
    }

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDD) maxDD = dd;

    if (open.length >= cfg.maxConcurrentTrades) continue;

    const candleAny = candleData[symbols[0]][bar];
    if (cfg.allowedHoursUtc) {
      const hour = new Date(candleAny.openTime).getUTCHours();
      if (!cfg.allowedHoursUtc.includes(hour)) continue;
    }

    // Entry signals via ensemble vote
    for (const asset of cappedAssets) {
      if (open.length >= cfg.maxConcurrentTrades) break;
      if (open.some((p) => p.asset === asset.symbol)) continue;

      const candle = candleData[asset.sourceSymbol]![bar];
      const { longVotes, shortVotes } = ensembleVote(
        candle,
        bandsData[asset.sourceSymbol],
        bar,
      );
      const a = atrData[asset.sourceSymbol]![bar];
      if (a === null || !Number.isFinite(a) || a! <= 0) continue;

      if (asset.allowLong && longVotes >= asset.minVotes) {
        const entryPrice = candle!.close;
        const stopPrice = entryPrice - a! * asset.atrStopMult;
        const tpPrice = entryPrice + a! * asset.tpAtrMult;
        const stopPct = (entryPrice - stopPrice) / entryPrice;
        if (cfg.liveCaps && stopPct > cfg.liveCaps.maxStopPct) continue; // skip if stop too wide
        open.push({
          asset: asset.symbol,
          symbol: asset.sourceSymbol,
          direction: "long",
          entryBar: bar,
          entryPrice,
          stopPrice,
          tpPrice,
          highWaterMark: entryPrice,
          lowWaterMark: entryPrice,
          riskFrac: asset.riskFrac,
          costBp: asset.costBp,
          swapBpPerDay: asset.swapBpPerDay,
          atrStopMult: asset.atrStopMult,
        });
        tradingDaysSet.add(dayIndex);
        continue;
      }

      if (asset.allowShort && shortVotes >= asset.minVotes) {
        const entryPrice = candle!.close;
        const stopPrice = entryPrice + a! * asset.atrStopMult;
        const tpPrice = entryPrice - a! * asset.tpAtrMult;
        const stopPct = (stopPrice - entryPrice) / entryPrice;
        if (cfg.liveCaps && stopPct > cfg.liveCaps.maxStopPct) continue;
        open.push({
          asset: asset.symbol,
          symbol: asset.sourceSymbol,
          direction: "short",
          entryBar: bar,
          entryPrice,
          stopPrice,
          tpPrice,
          highWaterMark: entryPrice,
          lowWaterMark: entryPrice,
          riskFrac: asset.riskFrac,
          costBp: asset.costBp,
          swapBpPerDay: asset.swapBpPerDay,
          atrStopMult: asset.atrStopMult,
        });
        tradingDaysSet.add(dayIndex);
      }
    }
  }

  const enoughDays = tradingDaysSet.size >= cfg.minTradingDays;
  if (targetReached && enoughDays)
    return {
      passed: true,
      reason: "passed",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDD,
      trades: closed,
      tradingDays: tradingDaysSet.size,
    };
  if (equity - 1 >= cfg.profitTarget && enoughDays)
    return {
      passed: true,
      reason: "passed",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDD,
      trades: closed,
      tradingDays: tradingDaysSet.size,
    };
  return {
    passed: false,
    reason: "timeout",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDD,
    trades: closed,
    tradingDays: tradingDaysSet.size,
  };
}

/** Default Donchian config — 5-period ensemble, ATR-based sizing, V5-similar asset universe. */
export const FTMO_DONCHIAN_CONFIG_BASE: DonchianEngineConfig = {
  timeframe: "2h",
  leverage: 2,
  profitTarget: 0.08,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  pauseAtTargetReached: true,
  liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  maxConcurrentTrades: 6,
  assets: [
    "ETHUSDT",
    "BTCUSDT",
    "BNBUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "LTCUSDT",
    "BCHUSDT",
    "LINKUSDT",
  ].map((s) => ({
    symbol: s.replace("USDT", "-DON"),
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    lookbacks: [10, 20, 30, 40, 50],
    minVotes: 3, // 3 of 5 lookbacks
    atrPeriod: 14,
    atrStopMult: 2.0,
    tpAtrMult: 3.5,
    holdBars: 240,
    allowLong: true,
    allowShort: false, // crypto: long-only avoids swap costs
  })),
};
