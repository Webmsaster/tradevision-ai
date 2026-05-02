import type { Candle } from "@/utils/indicators";
import { sma, atr } from "@/utils/indicators";
import type { StrategyDecision, StrategyConfig } from "@/utils/strategies";
import { DEFAULT_STRATEGY_CONFIG } from "@/utils/strategies";

// ---------------------------------------------------------------------------
// Proven-edge, long-only strategies. These exist to give the research engine
// rule-sets that the academic / practitioner literature has repeatedly shown
// to produce a positive expected return in trending assets:
//   - Golden Cross (Brock/Lakonishok/LeBaron 1992, replicated on crypto)
//   - Donchian long-only (Turtle system #2, 55-in / 20-out)
//   - Absolute momentum / time-series momentum (Moskowitz/Ooi/Pedersen 2012)
//
// All three are long-flat (no shorting). Crypto has a strong upward drift;
// shorting halves the hit-rate of every trend rule. Going flat during bear
// regimes is the single biggest contributor to risk-adjusted edge.
// ---------------------------------------------------------------------------

function flat(notes: string[] = []): StrategyDecision {
  return {
    action: "flat",
    strategy: "trend-follow",
    stopDistance: null,
    targetDistance: null,
    notes,
  };
}

// --- Golden Cross -----------------------------------------------------------
// Long when 50-SMA > 200-SMA. Flat when 50 < 200. A wide ATR stop acts as a
// catastrophic safety net; the real exit is the SMA cross itself (handled by
// the backtest engine's flip-exit).
export interface GoldenCrossConfig {
  fastPeriod: number;
  slowPeriod: number;
  stopAtrMult: number;
}
export const DEFAULT_GOLDEN_CROSS_CONFIG: GoldenCrossConfig = {
  fastPeriod: 50,
  slowPeriod: 200,
  stopAtrMult: 3,
};

export function goldenCrossStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  gc: GoldenCrossConfig = DEFAULT_GOLDEN_CROSS_CONFIG,
): StrategyDecision {
  if (candles.length < gc.slowPeriod + 5) return flat();
  const closes = candles.map((c) => c.close);
  const fastArr = sma(closes, gc.fastPeriod);
  const slowArr = sma(closes, gc.slowPeriod);
  const atrArr = atr(candles, 14);
  const i = candles.length - 1;
  const fastNow = fastArr[i];
  const slowNow = slowArr[i];
  const atrNow = atrArr[i];
  if (fastNow === null || slowNow === null || atrNow === null) return flat();

  if (fastNow! > slowNow!) {
    return {
      action: "long",
      strategy: "trend-follow",
      stopDistance: atrNow! * gc.stopAtrMult,
      targetDistance: atrNow! * 999, // no take-profit; let the cross exit
      notes: [
        `Golden cross active: ${gc.fastPeriod}-SMA ${fastNow!.toFixed(2)} > ${gc.slowPeriod}-SMA ${slowNow!.toFixed(2)}`,
      ],
    };
  }
  return flat([
    `Death cross: ${gc.fastPeriod}-SMA ${fastNow!.toFixed(2)} ≤ ${gc.slowPeriod}-SMA ${slowNow!.toFixed(2)} — stay flat`,
  ]);
}

// --- Donchian long-only (Turtle system #2) ---------------------------------
// Enter long on a new N-bar close high. Exit on an M-bar close low. N defaults
// to 55, M to 20, matching the original Turtle #2 rules. This is the system
// Richard Dennis used; still profitable on crypto daily/weekly bars because of
// the long-tail distribution of returns.
export interface DonchianConfig {
  entryPeriod: number;
  exitPeriod: number;
  stopAtrMult: number;
}
export const DEFAULT_DONCHIAN_CONFIG: DonchianConfig = {
  entryPeriod: 55,
  exitPeriod: 20,
  stopAtrMult: 2.5,
};

export function donchianLongOnlyStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  dc: DonchianConfig = DEFAULT_DONCHIAN_CONFIG,
): StrategyDecision {
  const minBars = Math.max(dc.entryPeriod, dc.exitPeriod) + 5;
  if (candles.length < minBars) return flat();
  const i = candles.length - 1;

  // Entry channel: highest high of the previous entryPeriod bars (exclusive)
  let entryHigh = -Infinity;
  for (let j = i - dc.entryPeriod; j < i; j++) {
    if (candles[j]!.high > entryHigh) entryHigh = candles[j]!.high;
  }
  // Exit channel: lowest low of the previous exitPeriod bars (exclusive)
  let exitLow = Infinity;
  for (let j = i - dc.exitPeriod; j < i; j++) {
    if (candles[j]!.low < exitLow) exitLow = candles[j]!.low;
  }

  const priceNow = candles[i]!.close;
  const atrArr = atr(candles, 14);
  const atrNow = atrArr[i];
  if (atrNow === null) return flat();

  // Long when price broke above the entry channel AND has not fallen through
  // the exit channel yet. The backtest engine's flip-to-flat exit closes the
  // position when this returns flat, so we only need to report "long" while
  // price remains above the 20-bar low.
  if (priceNow > entryHigh * 0.999 && priceNow > exitLow) {
    return {
      action: "long",
      strategy: "breakout",
      stopDistance: atrNow! * dc.stopAtrMult,
      targetDistance: atrNow! * 999,
      notes: [
        `Donchian ${dc.entryPeriod}-bar breakout: price ${priceNow.toFixed(2)} > channel high ${entryHigh.toFixed(2)}`,
      ],
    };
  }
  if (priceNow > exitLow && priceNow >= entryHigh * 0.97) {
    // We're still above the exit channel after a prior breakout — keep long.
    return {
      action: "long",
      strategy: "breakout",
      stopDistance: atrNow! * dc.stopAtrMult,
      targetDistance: atrNow! * 999,
      notes: [
        `Holding Donchian long: price ${priceNow.toFixed(2)} > ${dc.exitPeriod}-bar low ${exitLow.toFixed(2)}`,
      ],
    };
  }
  return flat([
    `Donchian flat: price ${priceNow.toFixed(2)} below ${dc.exitPeriod}-bar low ${exitLow.toFixed(2)}`,
  ]);
}

// --- Absolute Momentum / Time-Series Momentum -------------------------------
// Long when the N-bar rate-of-change is positive AND greater than a small
// threshold that filters chop. Flat otherwise. Replicates Moskowitz/Ooi/
// Pedersen 2012 "Time Series Momentum" on a single asset at bar resolution.
export interface MomentumConfig {
  lookbackBars: number;
  minRoc: number; // minimum momentum to trigger (e.g. 0.05 = +5%)
  stopAtrMult: number;
}
export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  lookbackBars: 12, // ~3 months on weekly, ~12 days on daily
  minRoc: 0.02,
  stopAtrMult: 3,
};

export function momentumStrategy(
  candles: Candle[],
  _cfg: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
  mc: MomentumConfig = DEFAULT_MOMENTUM_CONFIG,
): StrategyDecision {
  if (candles.length < mc.lookbackBars + 5) return flat();
  const i = candles.length - 1;
  const priceNow = candles[i]!.close;
  const priceBack = candles[i - mc.lookbackBars]!.close;
  const roc = (priceNow - priceBack) / priceBack;
  const atrArr = atr(candles, 14);
  const atrNow = atrArr[i];
  if (atrNow === null) return flat();

  if (roc > mc.minRoc) {
    return {
      action: "long",
      strategy: "trend-follow",
      stopDistance: atrNow! * mc.stopAtrMult,
      targetDistance: atrNow! * 999,
      notes: [
        `Momentum long: ${mc.lookbackBars}-bar ROC ${(roc * 100).toFixed(1)}% > ${(mc.minRoc * 100).toFixed(1)}% threshold`,
      ],
    };
  }
  return flat([
    `Momentum flat: ${mc.lookbackBars}-bar ROC ${(roc * 100).toFixed(1)}% below threshold`,
  ]);
}
