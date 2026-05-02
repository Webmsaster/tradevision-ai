/**
 * FTMO Mean-Reversion Engine — standalone (NOT a V5 clone).
 *
 * Strategy: RSI-based mean reversion.
 * - RSI(14) < 30 → LONG entry (oversold buy)
 * - RSI(14) > 70 → SHORT entry (overbought sell)
 * - Confirmation: wait for RSI to reverse direction (cross back through 30/70)
 * - Exit: tight SL + small TP, OR RSI reverts past 50 (MR complete)
 * - Position size: riskFrac × stopPct (live-caps applied)
 *
 * Different from V5 (trend-following):
 * - V5 enters on bar-color-trigger (in invertDirection mode = trend)
 * - MR enters on RSI extreme + reversal confirmation
 * - V5 holdBars long (240+); MR holdBars short (12-24, fast revert or stop)
 * - V5 R:R asymmetric (0.07/0.05); MR R:R closer (0.02/0.015)
 */
import type { Candle } from "./indicators";
import { rsi } from "./indicators";

export interface MrAssetConfig {
  symbol: string;
  sourceSymbol: string;
  costBp: number;
  slippageBp: number;
  swapBpPerDay: number;
  riskFrac: number;
  rsiPeriod: number; // typically 14
  rsiOversold: number; // 30 typical
  rsiOverbought: number; // 70 typical
  rsiNeutral: number; // 50 — exit when crossed
  stopPct: number;
  tpPct: number;
  holdBars: number;
  allowLong: boolean;
  allowShort: boolean;
}

export interface MrEngineConfig {
  assets: MrAssetConfig[];
  timeframe: "30m" | "1h" | "2h" | "4h";
  leverage: number;
  profitTarget: number; // 0.08 FTMO Step 1
  maxDailyLoss: number; // 0.05
  maxTotalLoss: number; // 0.10
  minTradingDays: number; // 4
  maxDays: number; // 30
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
  riskFrac: number;
  stopPct: number;
  costBp: number;
  swapBpPerDay: number;
}

interface ClosedTrade {
  asset: string;
  direction: "long" | "short";
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  reason: "tp" | "sl" | "rsi_revert" | "max_hold" | "force_close";
  pnlPct: number; // raw price move (positive = profit)
  effPnl: number; // effective on equity (after riskFrac, leverage, costs)
  day: number;
}

export interface MrEngineResult {
  passed: boolean;
  reason: "passed" | "total_loss" | "daily_loss" | "timeout";
  finalEquityPct: number; // 0 = breakeven, +0.08 = +8%
  maxDrawdown: number;
  trades: ClosedTrade[];
  tradingDays: number; // distinct calendar days with trades
}

const BARS_PER_DAY: Record<string, number> = {
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

export function runMrEngine(
  candleData: Record<string, Candle[]>,
  cfg: MrEngineConfig,
): MrEngineResult {
  const symbols = cfg.assets.map((a) => a.sourceSymbol);
  const n = Math.min(...symbols.map((s) => candleData[s]?.length ?? 0));
  if (n === 0) {
    return {
      passed: false,
      reason: "timeout",
      finalEquityPct: 0,
      maxDrawdown: 0,
      trades: [],
      tradingDays: 0,
    };
  }
  const barsPerDay = BARS_PER_DAY[cfg.timeframe];
  const maxBars = Math.min(n, cfg.maxDays * barsPerDay);

  // Pre-compute RSI for each asset
  const rsiData: Record<string, (number | null)[]> = {};
  for (const a of cfg.assets) {
    rsiData[a.sourceSymbol] = rsi(
      candleData[a.sourceSymbol]!.slice(0, maxBars).map((c) => c.close),
      a.rsiPeriod,
    );
  }

  // Apply live caps
  const cappedAssets = cfg.assets.map((a) => {
    let stop = a.stopPct;
    let risk = a.riskFrac;
    if (cfg.liveCaps) {
      stop = Math.min(stop, cfg.liveCaps.maxStopPct);
      risk = Math.min(risk, cfg.liveCaps.maxRiskFrac);
    }
    return { ...a, stopPct: stop, riskFrac: risk };
  });

  let equity = 1.0; // 1.0 = $100k baseline
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

  // RSI confirmation state per asset (waits for RSI to cross back) — kept
  // as `_`-prefixed to keep the (legacy) API shape; not currently consumed
  // in this MR engine variant.
  const _pendingLongConfirm: Record<string, boolean> = {};
  const _pendingShortConfirm: Record<string, boolean> = {};
  void _pendingLongConfirm;
  void _pendingShortConfirm;

  for (let bar = 1; bar < maxBars; bar++) {
    const dayIndex = Math.floor(bar / barsPerDay);
    if (dayIndex !== lastDayIndex) {
      // New day — reset daily-loss counter
      dailyStartEquity = equity;
      frozenForDay = false;
      lastDayIndex = dayIndex;
    }

    if (pausedAfterTarget) continue;

    // Check daily loss cap
    if (equity / dailyStartEquity - 1 <= -cfg.maxDailyLoss) {
      // Force close all open + freeze for the day
      for (const pos of open) {
        const _asset = cappedAssets.find((a) => a.symbol === pos.asset)!;
        void _asset;
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
      // Don't return — challenge continues, just wait for next day
      continue;
    }
    if (frozenForDay) continue;

    // Check total loss
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

    // Check profit target reached
    if (cfg.pauseAtTargetReached && equity - 1 >= cfg.profitTarget) {
      targetReached = true;
      // Force close all & wait for minTradingDays
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

    // Manage open positions
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const asset = cappedAssets.find((a) => a.symbol === pos.asset)!;
      const candle = candleData[pos.symbol]![bar];
      if (!candle) continue;

      let exitReason: ClosedTrade["reason"] | null = null;
      let exitPrice = candle.close;

      if (pos.direction === "long") {
        if (candle.low <= pos.stopPrice) {
          exitReason = "sl";
          exitPrice = pos.stopPrice;
        } else if (candle.high >= pos.tpPrice) {
          exitReason = "tp";
          exitPrice = pos.tpPrice;
        } else {
          const r = rsiData[pos.symbol]![bar];
          if (r !== null && r >= asset.rsiNeutral) {
            exitReason = "rsi_revert";
            exitPrice = candle.close;
          } else if (bar - pos.entryBar >= asset.holdBars) {
            exitReason = "max_hold";
            exitPrice = candle.close;
          }
        }
      } else {
        if (candle.high >= pos.stopPrice) {
          exitReason = "sl";
          exitPrice = pos.stopPrice;
        } else if (candle.low <= pos.tpPrice) {
          exitReason = "tp";
          exitPrice = pos.tpPrice;
        } else {
          const r = rsiData[pos.symbol]![bar];
          if (r !== null && r <= asset.rsiNeutral) {
            exitReason = "rsi_revert";
            exitPrice = candle.close;
          } else if (bar - pos.entryBar >= asset.holdBars) {
            exitReason = "max_hold";
            exitPrice = candle.close;
          }
        }
      }

      if (exitReason) {
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        // Cost adjustment
        const totalCostFrac =
          ((pos.costBp + asset.slippageBp) / 10000) * 2 +
          (pos.swapBpPerDay / 10000) *
            Math.max(1, Math.floor((bar - pos.entryBar) / barsPerDay));
        const adjPnl = rawPnl - totalCostFrac;
        const effPnl = adjPnl * cfg.leverage * pos.riskFrac;
        equity += effPnl;
        closed.push({
          asset: pos.asset,
          direction: pos.direction,
          entryBar: pos.entryBar,
          exitBar: bar,
          entryPrice: pos.entryPrice,
          exitPrice,
          reason: exitReason,
          pnlPct: rawPnl,
          effPnl,
          day: dayIndex,
        });
        open.splice(i, 1);
      }
    }

    // Update equity peak / drawdown
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDD) maxDD = dd;

    // Check entries
    if (open.length >= cfg.maxConcurrentTrades) continue;

    // Hour filter (if specified)
    const candleAny = candleData[symbols[0]][bar];
    if (cfg.allowedHoursUtc) {
      const hour = new Date(candleAny.openTime).getUTCHours();
      if (!cfg.allowedHoursUtc.includes(hour)) continue;
    }

    for (const asset of cappedAssets) {
      if (open.length >= cfg.maxConcurrentTrades) break;
      // Skip if already open on this asset
      if (open.some((p) => p.asset === asset.symbol)) continue;

      const r = rsiData[asset.sourceSymbol]![bar];
      const rPrev = rsiData[asset.sourceSymbol]![bar - 1];
      if (r === null || rPrev === null) continue;

      // Long entry: oversold then RSI crosses back above oversold threshold
      if (
        asset.allowLong &&
        rPrev <= asset.rsiOversold &&
        r > asset.rsiOversold
      ) {
        const entryPrice = candleData[asset.sourceSymbol]![bar].close;
        open.push({
          asset: asset.symbol,
          symbol: asset.sourceSymbol,
          direction: "long",
          entryBar: bar,
          entryPrice,
          stopPrice: entryPrice * (1 - asset.stopPct),
          tpPrice: entryPrice * (1 + asset.tpPct),
          riskFrac: asset.riskFrac,
          stopPct: asset.stopPct,
          costBp: asset.costBp,
          swapBpPerDay: asset.swapBpPerDay,
        });
        tradingDaysSet.add(dayIndex);
        continue;
      }

      // Short entry: overbought then RSI crosses back below overbought
      if (
        asset.allowShort &&
        rPrev >= asset.rsiOverbought &&
        r < asset.rsiOverbought
      ) {
        const entryPrice = candleData[asset.sourceSymbol]![bar].close;
        open.push({
          asset: asset.symbol,
          symbol: asset.sourceSymbol,
          direction: "short",
          entryBar: bar,
          entryPrice,
          stopPrice: entryPrice * (1 + asset.stopPct),
          tpPrice: entryPrice * (1 - asset.tpPct),
          riskFrac: asset.riskFrac,
          stopPct: asset.stopPct,
          costBp: asset.costBp,
          swapBpPerDay: asset.swapBpPerDay,
        });
        tradingDaysSet.add(dayIndex);
      }
    }
  }

  // Final pass check
  const enoughDays = tradingDaysSet.size >= cfg.minTradingDays;
  if (targetReached && enoughDays) {
    return {
      passed: true,
      reason: "passed",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDD,
      trades: closed,
      tradingDays: tradingDaysSet.size,
    };
  }
  if (equity - 1 >= cfg.profitTarget && enoughDays) {
    return {
      passed: true,
      reason: "passed",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDD,
      trades: closed,
      tradingDays: tradingDaysSet.size,
    };
  }
  return {
    passed: false,
    reason: "timeout",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDD,
    trades: closed,
    tradingDays: tradingDaysSet.size,
  };
}

/** Default MR config for FTMO Step 1 Crypto. */
export const FTMO_MR_CONFIG_BASE: MrEngineConfig = {
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
    {
      symbol: "ETH-MR",
      sourceSymbol: "ETHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "BTC-MR",
      sourceSymbol: "BTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "BNB-MR",
      sourceSymbol: "BNBUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "ADA-MR",
      sourceSymbol: "ADAUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "DOGE-MR",
      sourceSymbol: "DOGEUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "AVAX-MR",
      sourceSymbol: "AVAXUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "LTC-MR",
      sourceSymbol: "LTCUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "BCH-MR",
      sourceSymbol: "BCHUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
    {
      symbol: "LINK-MR",
      sourceSymbol: "LINKUSDT",
      costBp: 30,
      slippageBp: 8,
      swapBpPerDay: 4,
      riskFrac: 1.0,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      rsiNeutral: 50,
      stopPct: 0.025,
      tpPct: 0.02,
      holdBars: 24,
      allowLong: true,
      allowShort: true,
    },
  ],
};
