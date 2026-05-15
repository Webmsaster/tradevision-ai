/**
 * 2026-05-15 TS port of `engine-rust/ftmo-engine-core/src/signals_supertrend.rs`
 * (feature/r28-deploy branch).
 *
 * Supertrend trend-direction voter. ATR-based trailing line with hysteresis.
 *
 * Voting contract:
 *   - Long-vote if trend at `signal_idx = candles.len() - 2` is Up.
 *   - Short-vote if Down.
 *   - Abstain (null) on insufficient warmup, ATR=0 throughout, or any
 *     numerical pathology.
 *
 * Lookahead-safe: entry bar `candles[len - 1]` is NEVER read.
 */
import type { Candle } from "@/utils/indicators";
import { atrWilder } from "@/utils/regimeVoters/types";
import type { VoterSide } from "@/utils/regimeVoters/types";

export interface SupertrendParams {
  /** ATR Wilder-smoothing period. Default 10. */
  atrPeriod: number;
  /** Band-width multiplier. Default 3.0. */
  multiplier: number;
}

export function defaultSupertrendParams(): SupertrendParams {
  return { atrPeriod: 10, multiplier: 3.0 };
}

export function computeSupertrendVote(
  candles: Candle[],
  params: SupertrendParams = defaultSupertrendParams(),
): VoterSide {
  if (
    params.atrPeriod <= 0 ||
    !Number.isFinite(params.multiplier) ||
    params.multiplier <= 0
  ) {
    return null;
  }
  if (candles.length < params.atrPeriod + 3) return null;
  const signalIdx = candles.length - 2;
  if (signalIdx < params.atrPeriod + 1) return null;

  const atrSeries = atrWilder(candles, params.atrPeriod);

  let upperFinal = Number.NaN;
  let lowerFinal = Number.NaN;
  type Trend = "up" | "down" | null;
  let trend: Trend = null;

  for (let i = params.atrPeriod + 1; i <= signalIdx; i++) {
    const c = candles[i]!;
    if (
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      // Hold prior state on poisoned bar — do not flip.
      continue;
    }
    const atrV = atrSeries[i];
    if (atrV == null || !Number.isFinite(atrV) || atrV <= 0) {
      // ATR not yet defined / non-finite — skip safely.
      continue;
    }
    const hl2 = 0.5 * (c.high + c.low);
    const upperBasic = hl2 + params.multiplier * atrV;
    const lowerBasic = hl2 - params.multiplier * atrV;

    const prevClose = candles[i - 1]!.close;

    // Recursive upper_final.
    const newUpper =
      !Number.isFinite(upperFinal) ||
      upperBasic < upperFinal ||
      (Number.isFinite(prevClose) && prevClose > upperFinal)
        ? upperBasic
        : upperFinal;
    const newLower =
      !Number.isFinite(lowerFinal) ||
      lowerBasic > lowerFinal ||
      (Number.isFinite(prevClose) && prevClose < lowerFinal)
        ? lowerBasic
        : lowerFinal;
    upperFinal = newUpper;
    lowerFinal = newLower;

    // Trend flip-rule.
    if (trend === null) {
      if (c.close > upperFinal) trend = "up";
      else if (c.close < lowerFinal) trend = "down";
      else trend = "up";
    } else if (trend === "up") {
      if (c.close < lowerFinal) trend = "down";
    } else if (trend === "down") {
      if (c.close > upperFinal) trend = "up";
    }
  }

  if (trend === "up") return "long";
  if (trend === "down") return "short";
  return null;
}
