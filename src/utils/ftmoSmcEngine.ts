/**
 * FTMO Smart-Money-Concepts (SMC) Engine — ICT-style:
 * - Fair Value Gap (FVG) entries
 * - Liquidity Sweep entries
 * - Order Block entries (simplified: last bull/bear candle before strong move)
 *
 * Different from V5 (EMA/ADX trend), MR (RSI), Donchian (breakout).
 */
import type { Candle } from "./indicators";
import { atr } from "./indicators";
import { pragueDay } from "./ftmoDaytrade24h";

export interface SmcAssetConfig {
  symbol: string;
  sourceSymbol: string;
  costBp: number;
  slippageBp: number;
  swapBpPerDay: number;
  riskFrac: number;
  // SMC params
  fvgEnabled: boolean;
  fvgLookback: number; // how many bars to look back for FVG (e.g., 20)
  obEnabled: boolean;
  obStrongMoveAtr: number; // ATR multiple for "strong move" defining OB (e.g., 2.0)
  sweepEnabled: boolean;
  sweepLookback: number; // bars to look back for swing high/low
  sweepWickPct: number; // wick must exceed by X% (0.001 = 0.1%)
  // Exits
  atrStopMult: number;
  atrTpMult: number;
  holdBars: number;
  allowLong: boolean;
  allowShort: boolean;
}

export interface SmcEngineConfig {
  assets: SmcAssetConfig[];
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
  riskFrac: number;
  costBp: number;
  swapBpPerDay: number;
  setup: "fvg" | "ob" | "sweep";
}

interface ClosedTrade {
  asset: string;
  direction: "long" | "short";
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  reason: "tp" | "sl" | "max_hold" | "force_close";
  setup: string;
  pnlPct: number;
  effPnl: number;
  day: number;
}

export interface SmcEngineResult {
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

/**
 * Detect bullish FVG at bar i: bar[i].low > bar[i-2].high (3-bar gap up).
 * Returns true if FVG present and not yet filled at this bar.
 */
function isBullishFvgEntry(c: Candle[], i: number, lookback: number): boolean {
  if (i < 2) return false;
  // Look for FVG within lookback window — first detect it, then check still unfilled
  for (let j = Math.max(2, i - lookback); j <= i; j++) {
    const fvgBottom = c[j - 2]!.high;
    const fvgTop = c[j]!.low;
    if (fvgTop <= fvgBottom) continue; // no FVG
    // Is current bar entering this gap from above?
    const currentBar = c[i];
    if (
      currentBar!.low <= fvgTop &&
      currentBar!.low >= fvgBottom &&
      currentBar!.close > fvgBottom
    ) {
      // entering FVG zone from above + closing inside or above → bullish entry
      return true;
    }
  }
  return false;
}

function isBearishFvgEntry(c: Candle[], i: number, lookback: number): boolean {
  if (i < 2) return false;
  for (let j = Math.max(2, i - lookback); j <= i; j++) {
    const fvgTop = c[j - 2]!.low;
    const fvgBottom = c[j]!.high;
    if (fvgBottom >= fvgTop) continue;
    const currentBar = c[i];
    if (
      currentBar!.high >= fvgBottom &&
      currentBar!.high <= fvgTop &&
      currentBar!.close < fvgTop
    ) {
      return true;
    }
  }
  return false;
}

/** Bullish liquidity sweep: wick below recent low, close back above */
function isBullishSweep(
  c: Candle[],
  i: number,
  lookback: number,
  wickPct: number,
): boolean {
  if (i < lookback) return false;
  let recentLow = Infinity;
  for (let j = i - lookback; j < i; j++)
    recentLow = Math.min(recentLow, c[j]!.low);
  const cur = c[i];
  const sweepDepth = (recentLow - cur!.low) / recentLow;
  if (sweepDepth < wickPct) return false; // wick must dip below by wickPct
  // Close back above recentLow
  return cur!.close > recentLow;
}

function isBearishSweep(
  c: Candle[],
  i: number,
  lookback: number,
  wickPct: number,
): boolean {
  if (i < lookback) return false;
  let recentHigh = -Infinity;
  for (let j = i - lookback; j < i; j++)
    recentHigh = Math.max(recentHigh, c[j]!.high);
  const cur = c[i];
  const sweepDepth = (cur!.high - recentHigh) / recentHigh;
  if (sweepDepth < wickPct) return false;
  return cur!.close < recentHigh;
}

/** Order Block: last bearish candle before a strong bullish move (= bullish OB) */
function isBullishOb(
  c: Candle[],
  i: number,
  atrVal: number,
  strongMoveMult: number,
): boolean {
  // Look at last 5 bars: was there a strong bullish move?
  if (i < 5 || atrVal <= 0) return false;
  const move = c[i]!.close - c[i - 4]!.close;
  const strongMove = atrVal * strongMoveMult;
  if (move < strongMove) return false;
  // Find the last bearish candle in the move's start zone
  // Simple proxy: bar[i-4] should be bearish (close < open) and bar[i-3..i] should be net bullish
  return c[i - 4]!.close < c[i - 4]!.open && c[i]!.close > c[i - 4]!.high;
}

function isBearishOb(
  c: Candle[],
  i: number,
  atrVal: number,
  strongMoveMult: number,
): boolean {
  if (i < 5 || atrVal <= 0) return false;
  const move = c[i - 4]!.close - c[i]!.close;
  const strongMove = atrVal * strongMoveMult;
  if (move < strongMove) return false;
  return c[i - 4]!.close > c[i - 4]!.open && c[i]!.close < c[i - 4]!.low;
}

export function runSmcEngine(
  candleData: Record<string, Candle[]>,
  cfg: SmcEngineConfig,
): SmcEngineResult {
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

  const atrData: Record<string, (number | null)[]> = {};
  for (const a of cfg.assets)
    atrData[a.sourceSymbol] = atr(
      candleData[a.sourceSymbol]!.slice(0, maxBars),
      14,
    );

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

  // Phase 83 (R51-FTMO-2): Prague day-key, matching main engine.
  const ts0 = candleData[symbols[0]!]?.[0]?.closeTime ?? 0;
  const ts0Day = pragueDay(ts0);

  for (let bar = 5; bar < maxBars; bar++) {
    const tsBar = candleData[symbols[0]!]?.[bar]?.closeTime ?? 0;
    const dayIndex = pragueDay(tsBar) - ts0Day;
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
        // Phase 83 (R51-FTMO-3): compound to match main engine.
        equity *= 1 + effPnl;
        closed.push({
          asset: pos.asset,
          direction: pos.direction,
          entryBar: pos.entryBar,
          exitBar: bar,
          entryPrice: pos.entryPrice,
          exitPrice,
          reason: "force_close",
          setup: pos.setup,
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
    if (equity - 1 <= -cfg.maxTotalLoss)
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDD,
        trades: closed,
        tradingDays: tradingDaysSet.size,
      };

    if (cfg.pauseAtTargetReached && equity - 1 >= cfg.profitTarget) {
      targetReached = true;
      for (const pos of open) {
        const exitPrice = candleData[pos.symbol]![bar]?.close ?? pos.entryPrice;
        const rawPnl =
          pos.direction === "long"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const effPnl = rawPnl * cfg.leverage * pos.riskFrac;
        // Phase 83 (R51-FTMO-3): compound to match main engine.
        equity *= 1 + effPnl;
        closed.push({
          asset: pos.asset,
          direction: pos.direction,
          entryBar: pos.entryBar,
          exitBar: bar,
          entryPrice: pos.entryPrice,
          exitPrice,
          reason: "force_close",
          setup: pos.setup,
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
      const candle = candleData[pos!.symbol]![bar];
      const asset = cappedAssets.find((a) => a.symbol === pos!.asset)!;
      if (!candle) continue;
      let exitReason: ClosedTrade["reason"] | null = null;
      let exitPrice = candle.close;
      if (pos!.direction === "long") {
        if (candle.low <= pos!.stopPrice) {
          exitReason = "sl";
          exitPrice = pos!.stopPrice;
        } else if (candle.high >= pos!.tpPrice) {
          exitReason = "tp";
          exitPrice = pos!.tpPrice;
        } else if (bar - pos!.entryBar >= asset.holdBars) {
          exitReason = "max_hold";
        }
      } else {
        if (candle.high >= pos!.stopPrice) {
          exitReason = "sl";
          exitPrice = pos!.stopPrice;
        } else if (candle.low <= pos!.tpPrice) {
          exitReason = "tp";
          exitPrice = pos!.tpPrice;
        } else if (bar - pos!.entryBar >= asset.holdBars) {
          exitReason = "max_hold";
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
        // Phase 83 (R51-FTMO-3): compound to match main engine.
        equity *= 1 + effPnl;
        closed.push({
          asset: pos!.asset,
          direction: pos!.direction,
          entryBar: pos!.entryBar,
          exitBar: bar,
          entryPrice: pos!.entryPrice,
          exitPrice,
          reason: exitReason,
          setup: pos!.setup,
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
    const candleAny = candleData[symbols[0]!]![bar]!;
    if (cfg.allowedHoursUtc) {
      const hour = new Date(candleAny.openTime).getUTCHours();
      if (!cfg.allowedHoursUtc.includes(hour)) continue;
    }

    // Check entries
    for (const asset of cappedAssets) {
      if (open.length >= cfg.maxConcurrentTrades) break;
      if (open.some((p) => p.asset === asset.symbol)) continue;
      const c = candleData[asset.sourceSymbol]!;
      const a = atrData[asset.sourceSymbol]![bar];
      if (a === null || !Number.isFinite(a) || a! <= 0) continue;

      let entrySignal: {
        dir: "long" | "short";
        setup: "fvg" | "ob" | "sweep";
      } | null = null;

      // Long signals
      if (asset.allowLong) {
        if (asset.fvgEnabled && isBullishFvgEntry(c, bar, asset.fvgLookback))
          entrySignal = { dir: "long", setup: "fvg" };
        else if (
          asset.sweepEnabled &&
          isBullishSweep(c, bar, asset.sweepLookback, asset.sweepWickPct)
        )
          entrySignal = { dir: "long", setup: "sweep" };
        else if (
          asset.obEnabled &&
          isBullishOb(c, bar, a!, asset.obStrongMoveAtr)
        )
          entrySignal = { dir: "long", setup: "ob" };
      }
      // Short signals
      if (!entrySignal && asset.allowShort) {
        if (asset.fvgEnabled && isBearishFvgEntry(c, bar, asset.fvgLookback))
          entrySignal = { dir: "short", setup: "fvg" };
        else if (
          asset.sweepEnabled &&
          isBearishSweep(c, bar, asset.sweepLookback, asset.sweepWickPct)
        )
          entrySignal = { dir: "short", setup: "sweep" };
        else if (
          asset.obEnabled &&
          isBearishOb(c, bar, a!, asset.obStrongMoveAtr)
        )
          entrySignal = { dir: "short", setup: "ob" };
      }

      if (!entrySignal) continue;

      const entryPrice = c![bar]!.close;
      const stopDist = a! * asset.atrStopMult;
      const tpDist = a! * asset.atrTpMult;
      const stopPrice =
        entrySignal.dir === "long"
          ? entryPrice - stopDist
          : entryPrice + stopDist;
      const tpPrice =
        entrySignal.dir === "long" ? entryPrice + tpDist : entryPrice - tpDist;
      const stopPct = stopDist / entryPrice;
      if (cfg.liveCaps && stopPct > cfg.liveCaps.maxStopPct) continue;

      open.push({
        asset: asset.symbol,
        symbol: asset.sourceSymbol,
        direction: entrySignal.dir,
        entryBar: bar,
        entryPrice,
        stopPrice,
        tpPrice,
        riskFrac: asset.riskFrac,
        costBp: asset.costBp,
        swapBpPerDay: asset.swapBpPerDay,
        setup: entrySignal.setup,
      });
      tradingDaysSet.add(dayIndex);
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

export const FTMO_SMC_CONFIG_BASE: SmcEngineConfig = {
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
    symbol: s.replace("USDT", "-SMC"),
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    fvgEnabled: true,
    fvgLookback: 20,
    obEnabled: true,
    obStrongMoveAtr: 2.0,
    sweepEnabled: true,
    sweepLookback: 20,
    sweepWickPct: 0.001,
    atrStopMult: 1.5,
    atrTpMult: 2.5,
    holdBars: 48,
    allowLong: true,
    allowShort: false,
  })),
};
