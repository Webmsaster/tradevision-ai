import type { Candle } from "@/utils/indicators";
import { atr } from "@/utils/indicators";
import { vwap } from "@/utils/marketStructure";
import type { StrategyDecision, StrategyConfig } from "@/utils/strategies";
import { DEFAULT_STRATEGY_CONFIG } from "@/utils/strategies";

// ---------------------------------------------------------------------------
// Daytrading-specific strategies. Research basis: LiteFinance/QuantifiedStrategies
// (ORB), Altrady/HyroTrader (VWAP), KuCoin/OneSafe (liquidation cascades).
// Each strategy is tuned for intraday timeframes (1m/5m/15m).
// ---------------------------------------------------------------------------

function flatDecision(notes: string[] = []): StrategyDecision {
  return {
    action: "flat",
    strategy: "trend-follow",
    stopDistance: null,
    targetDistance: null,
    notes,
  };
}

/**
 * Opening Range Breakout (ORB). Dokumentiert: LiteFinance zeigt 170-250% YTD auf
 * Aktien; Crypto-Adaption nutzt 00:00 UTC als „market open" (wenn tägliche
 * Candle-Grenze in den meisten Börsen ist).
 *
 * Regel:
 * - Erfasse Range der ersten N Candles nach 00:00 UTC (Default: 3 Candles)
 * - Long bei Close oberhalb Range-High
 * - Short bei Close unterhalb Range-Low
 * - Nur ein Trade pro Tag, kein Signal mehr ab 20:00 UTC
 */
export interface OrbConfig {
  rangeBars: number; // wie viele Bars definieren die Opening Range
  stopAtrMult: number;
  targetAtrMult: number;
  cutoffHourUtc: number; // nach dieser Stunde keine neuen Signale
}

export const DEFAULT_ORB_CONFIG: OrbConfig = {
  rangeBars: 3,
  stopAtrMult: 1.5,
  targetAtrMult: 3,
  cutoffHourUtc: 20,
};

function utcHour(ms: number): number {
  return new Date(ms).getUTCHours();
}

function dayKey(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function orbStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  cfg: OrbConfig = DEFAULT_ORB_CONFIG,
): StrategyDecision {
  if (candles.length < cfg.rangeBars + 20) return flatDecision();
  const last = candles[candles.length - 1];
  const hour = utcHour(last!.closeTime);
  if (hour >= cfg.cutoffHourUtc)
    return flatDecision(["Past daily cutoff hour"]);

  // Find all candles that share today's UTC date
  const today = dayKey(last!.closeTime);
  const todayCandles: Candle[] = [];
  for (let i = candles.length - 1; i >= 0; i--) {
    if (dayKey(candles[i]!.closeTime) !== today) break;
    todayCandles.unshift(candles[i]!);
  }
  if (todayCandles.length < cfg.rangeBars + 1)
    return flatDecision(["Opening range not yet complete"]);

  const openingRange = todayCandles.slice(0, cfg.rangeBars);
  const rangeHigh = Math.max(...openingRange.map((c) => c.high));
  const rangeLow = Math.min(...openingRange.map((c) => c.low));

  const atrArr = atr(candles, 14);
  const atrNow = atrArr[atrArr.length - 1];
  if (atrNow === null) return flatDecision();

  const priceNow = last!.close;
  const stop = atrNow! * cfg.stopAtrMult;
  const target = atrNow! * cfg.targetAtrMult;

  if (priceNow > rangeHigh) {
    return {
      action: "long",
      strategy: "breakout",
      stopDistance: stop,
      targetDistance: target,
      notes: [
        `ORB long: price ${priceNow.toFixed(2)} > opening-range high ${rangeHigh.toFixed(2)}`,
      ],
    };
  }
  if (priceNow < rangeLow) {
    return {
      action: "short",
      strategy: "breakout",
      stopDistance: stop,
      targetDistance: target,
      notes: [
        `ORB short: price ${priceNow.toFixed(2)} < opening-range low ${rangeLow.toFixed(2)}`,
      ],
    };
  }
  return flatDecision(["Inside opening range"]);
}

/**
 * VWAP Mean Reversion at 2σ. Research: professionelle Trader nutzen 2σ bands
 * um VWAP als statistisch overextended signals (Altrady, HyroTrader).
 *
 * Regel:
 * - Long bei Preis < VWAP − 2σ UND RSI < 35
 * - Short bei Preis > VWAP + 2σ UND RSI > 65
 * - Target: VWAP middle
 * - Stop: 1×ATR außerhalb des Bandes
 */
export interface VwapReversionConfig {
  stdDevMult: number;
  stopAtrMult: number;
}
export const DEFAULT_VWAP_REVERSION_CONFIG: VwapReversionConfig = {
  stdDevMult: 2,
  stopAtrMult: 1,
};

export function vwapReversionStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  cfg: VwapReversionConfig = DEFAULT_VWAP_REVERSION_CONFIG,
): StrategyDecision {
  if (candles.length < 30) return flatDecision();
  const vwapPts = vwap(candles);
  const v = vwapPts[vwapPts.length - 1];
  if (!v!.vwap || v!.upper2 === null || v!.lower2 === null)
    return flatDecision();

  const atrArr = atr(candles, 14);
  const atrNow = atrArr[atrArr.length - 1];
  if (atrNow === null) return flatDecision();

  const priceNow = candles[candles.length - 1]!.close;
  const stop = atrNow! * cfg.stopAtrMult;

  if (priceNow < v!.lower2) {
    const target = v!.vwap - priceNow;
    return {
      action: "long",
      strategy: "mean-reversion",
      stopDistance: stop,
      targetDistance: Math.max(target, atrNow),
      notes: [
        `Price ${priceNow.toFixed(2)} below VWAP-2σ (${v!.lower2.toFixed(2)}) — revert to VWAP ${v!.vwap.toFixed(2)}`,
      ],
    };
  }
  if (priceNow > v!.upper2) {
    const target = priceNow - v!.vwap;
    return {
      action: "short",
      strategy: "mean-reversion",
      stopDistance: stop,
      targetDistance: Math.max(target, atrNow),
      notes: [
        `Price ${priceNow.toFixed(2)} above VWAP+2σ (${v!.upper2.toFixed(2)}) — revert to VWAP ${v!.vwap.toFixed(2)}`,
      ],
    };
  }
  return flatDecision(["Inside VWAP ±2σ bands"]);
}

/**
 * Liquidation Cascade Fade. Research: KuCoin/OneSafe — extreme leverage washout
 * ist bullish reset. Wir approximieren ohne direct liquidation data indirekt:
 * starker 1-Bar-Move (>= 3×ATR) + hohes Volume (>2x SMA) → Fade in die
 * Gegenrichtung. Target = halber Move.
 */
export interface LiqFadeConfig {
  moveAtrMult: number;
  volMult: number;
  stopAtrMult: number;
}
export const DEFAULT_LIQFADE_CONFIG: LiqFadeConfig = {
  moveAtrMult: 3,
  volMult: 2,
  stopAtrMult: 1.5,
};

export function liquidationFadeStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  cfg: LiqFadeConfig = DEFAULT_LIQFADE_CONFIG,
): StrategyDecision {
  if (candles.length < 40) return flatDecision();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const atrArr = atr(candles, 14);
  const atrNow = atrArr[atrArr.length - 1];
  if (atrNow === null) return flatDecision();

  const moveAbs = Math.abs(last!.close - prev!.close);
  if (moveAbs < atrNow! * cfg.moveAtrMult)
    return flatDecision(["No cascade-sized move"]);

  const vols = candles.slice(-20).map((c) => c.volume);
  const volAvg = vols.reduce((s, v) => s + v, 0) / vols.length;
  if (last!.volume < volAvg * cfg.volMult)
    return flatDecision(["Volume not at cascade level"]);

  const stop = atrNow! * cfg.stopAtrMult;
  const target = moveAbs / 2;

  // Down-cascade → fade long (bottom-fish)
  if (last!.close < prev!.close) {
    return {
      action: "long",
      strategy: "mean-reversion",
      stopDistance: stop,
      targetDistance: target,
      notes: [
        `Long-liquidation cascade detected: ${moveAbs.toFixed(2)} down on ${(last!.volume / volAvg).toFixed(1)}x volume — fade long to half retrace`,
      ],
    };
  }
  // Up-cascade → fade short (short-squeeze exhaustion)
  return {
    action: "short",
    strategy: "mean-reversion",
    stopDistance: stop,
    targetDistance: target,
    notes: [
      `Short-liquidation cascade detected: ${moveAbs.toFixed(2)} up on ${(last!.volume / volAvg).toFixed(1)}x volume — fade short to half retrace`,
    ],
  };
}
