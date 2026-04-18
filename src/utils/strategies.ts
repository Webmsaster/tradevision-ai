import type { Candle } from "@/utils/indicators";
import { ema, rsi, atr, adx, macd } from "@/utils/indicators";
import { bollingerBands } from "@/utils/marketStructure";

// ---------------------------------------------------------------------------
// Multi-strategy library. Each strategy is a pure function from candles to an
// action/direction decision for the *latest* candle. A regime-switcher selects
// which one is live for each bar so that trend strategies run in trends, and
// mean-reversion runs in range — the single biggest source of edge decay in
// public TA systems comes from running one rule in every regime.
// ---------------------------------------------------------------------------

export type StrategyAction = "long" | "short" | "flat";
export type StrategyName = "trend-follow" | "mean-reversion" | "breakout";

export interface StrategyConfig {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  adxTrendThreshold: number;
  bbPeriod: number;
  bbStdDev: number;
  donchianPeriod: number;
  stopAtrMult: number;
  targetAtrMult: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  atrPeriod: 14,
  adxPeriod: 14,
  adxTrendThreshold: 22,
  bbPeriod: 20,
  bbStdDev: 2,
  donchianPeriod: 20,
  stopAtrMult: 2,
  targetAtrMult: 3,
};

export interface StrategyDecision {
  action: StrategyAction;
  strategy: StrategyName;
  stopDistance: number | null;
  targetDistance: number | null;
  notes: string[];
}

export interface Regime {
  name: "trend" | "range" | "volatile" | "quiet";
  adx: number | null;
  bbWidthPct: number | null;
}

/**
 * Classify the current regime by ADX (trend-strength) and BBW (volatility).
 * Each regime maps to one preferred strategy in `pickStrategy`.
 */
export function detectRegime(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): Regime {
  const closes = candles.map((c) => c.close);
  const adxArr = adx(candles, cfg.adxPeriod);
  const bb = bollingerBands(closes, cfg.bbPeriod, cfg.bbStdDev);
  const adxNow = adxArr.adx.at(-1) ?? null;
  const bbwNow = bb.widthPct.at(-1) ?? null;

  if (adxNow === null || bbwNow === null)
    return { name: "quiet", adx: adxNow, bbWidthPct: bbwNow };

  if (adxNow >= cfg.adxTrendThreshold)
    return { name: "trend", adx: adxNow, bbWidthPct: bbwNow };
  if (bbwNow > 6) return { name: "volatile", adx: adxNow, bbWidthPct: bbwNow };
  if (bbwNow < 2) return { name: "quiet", adx: adxNow, bbWidthPct: bbwNow };
  return { name: "range", adx: adxNow, bbWidthPct: bbwNow };
}

function flatDecision(
  strategy: StrategyName,
  notes: string[] = [],
): StrategyDecision {
  return {
    action: "flat",
    strategy,
    stopDistance: null,
    targetDistance: null,
    notes,
  };
}

/**
 * Trend-follow: EMA crossover + MACD confirmation. Runs in `trend` regime.
 */
export function trendFollowStrategy(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyDecision {
  if (candles.length < cfg.emaSlow + 5) return flatDecision("trend-follow");
  const closes = candles.map((c) => c.close);
  const emaFastArr = ema(closes, cfg.emaFast);
  const emaSlowArr = ema(closes, cfg.emaSlow);
  const macdArr = macd(closes, 12, 26, 9);
  const atrArr = atr(candles, cfg.atrPeriod);
  const i = candles.length - 1;

  const fast = emaFastArr[i],
    slow = emaSlowArr[i],
    atrNow = atrArr[i];
  const histNow = macdArr.histogram[i],
    histPrev = macdArr.histogram[i - 1];
  if (fast === null || slow === null || atrNow === null)
    return flatDecision("trend-follow");

  const stop = atrNow * cfg.stopAtrMult;
  const target = atrNow * cfg.targetAtrMult;
  const notes: string[] = [];

  if (
    fast > slow &&
    histNow !== null &&
    histPrev !== null &&
    histNow > histPrev
  ) {
    notes.push("EMA fast > EMA slow, MACD hist rising");
    return {
      action: "long",
      strategy: "trend-follow",
      stopDistance: stop,
      targetDistance: target,
      notes,
    };
  }
  if (
    fast < slow &&
    histNow !== null &&
    histPrev !== null &&
    histNow < histPrev
  ) {
    notes.push("EMA fast < EMA slow, MACD hist falling");
    return {
      action: "short",
      strategy: "trend-follow",
      stopDistance: stop,
      targetDistance: target,
      notes,
    };
  }
  return flatDecision("trend-follow", ["no trend-follow signal"]);
}

/**
 * Mean-reversion: fade extreme RSI readings when price pushes outside
 * Bollinger Bands. Runs in `range` or `quiet` regimes only.
 */
export function meanReversionStrategy(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyDecision {
  if (candles.length < cfg.bbPeriod + 5) return flatDecision("mean-reversion");
  const closes = candles.map((c) => c.close);
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const bb = bollingerBands(closes, cfg.bbPeriod, cfg.bbStdDev);
  const atrArr = atr(candles, cfg.atrPeriod);
  const i = candles.length - 1;
  const priceNow = closes[i];
  const rsiNow = rsiArr[i];
  const upper = bb.upper[i];
  const lower = bb.lower[i];
  const middle = bb.middle[i];
  const atrNow = atrArr[i];
  if (
    rsiNow === null ||
    upper === null ||
    lower === null ||
    middle === null ||
    atrNow === null
  ) {
    return flatDecision("mean-reversion");
  }

  const stop = atrNow * cfg.stopAtrMult;
  // For mean reversion target the middle band, not 3×ATR
  const targetLong = middle - priceNow;
  const targetShort = priceNow - middle;

  if (priceNow < lower && rsiNow < 30) {
    return {
      action: "long",
      strategy: "mean-reversion",
      stopDistance: stop,
      targetDistance: Math.max(targetLong, atrNow),
      notes: [
        `Price below lower BB, RSI ${rsiNow.toFixed(1)} oversold — fade to mid`,
      ],
    };
  }
  if (priceNow > upper && rsiNow > 70) {
    return {
      action: "short",
      strategy: "mean-reversion",
      stopDistance: stop,
      targetDistance: Math.max(targetShort, atrNow),
      notes: [
        `Price above upper BB, RSI ${rsiNow.toFixed(1)} overbought — fade to mid`,
      ],
    };
  }
  return flatDecision("mean-reversion", ["no mean-reversion signal"]);
}

/**
 * Breakout: Donchian channel break + ATR-filter for false breakouts.
 * Runs in `quiet` (compression breakout) or `volatile` regimes.
 */
export function breakoutStrategy(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyDecision {
  if (candles.length < cfg.donchianPeriod + 5) return flatDecision("breakout");
  const atrArr = atr(candles, cfg.atrPeriod);
  const i = candles.length - 1;
  const lookbackStart = i - cfg.donchianPeriod;
  let highest = -Infinity;
  let lowest = Infinity;
  for (let j = lookbackStart; j < i; j++) {
    if (candles[j].high > highest) highest = candles[j].high;
    if (candles[j].low < lowest) lowest = candles[j].low;
  }
  const priceNow = candles[i].close;
  const atrNow = atrArr[i];
  if (atrNow === null) return flatDecision("breakout");

  const stop = atrNow * cfg.stopAtrMult;
  const target = atrNow * cfg.targetAtrMult;
  const filter = atrNow * 0.2;

  if (priceNow > highest + filter) {
    return {
      action: "long",
      strategy: "breakout",
      stopDistance: stop,
      targetDistance: target,
      notes: [
        `Close ${priceNow.toFixed(2)} above ${cfg.donchianPeriod}-bar high + 0.2 ATR filter`,
      ],
    };
  }
  if (priceNow < lowest - filter) {
    return {
      action: "short",
      strategy: "breakout",
      stopDistance: stop,
      targetDistance: target,
      notes: [
        `Close ${priceNow.toFixed(2)} below ${cfg.donchianPeriod}-bar low - 0.2 ATR filter`,
      ],
    };
  }
  return flatDecision("breakout", ["no breakout signal"]);
}

/**
 * Regime-switcher: picks the strategy best suited to the current regime and
 * returns its decision. Returns flat if no strategy fits.
 */
export function regimeSwitch(
  candles: Candle[],
  cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): { regime: Regime; decision: StrategyDecision } {
  const regime = detectRegime(candles, cfg);
  let decision: StrategyDecision;
  switch (regime.name) {
    case "trend":
      decision = trendFollowStrategy(candles, cfg);
      break;
    case "range":
    case "quiet":
      decision = meanReversionStrategy(candles, cfg);
      break;
    case "volatile":
      decision = breakoutStrategy(candles, cfg);
      break;
    default:
      decision = flatDecision("trend-follow", ["unknown regime"]);
  }
  return { regime, decision };
}
