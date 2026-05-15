/**
 * 2026-05-15 TS port of `engine-rust/ftmo-engine-core/src/signals_smc_fvg.rs`
 * (feature/r28-deploy branch).
 *
 * SMC Fair-Value-Gap (FVG) voter. 3-bar imbalance pattern with retest.
 *
 * Voting contract:
 *   - Bullish FVG: scan `[signal_idx - lookback ..= signal_idx - 3]` for
 *     a triplet (k, k+1, k+2) where `candles[k+2].low > candles[k].high`
 *     AND impulse-bar (k+1) absolute body / open ≥ fvgImpulseMinPct AND
 *     gap width / fvg_bottom ≥ fvgMinWidthPct. Retest contract:
 *     signal_bar.low ≤ fvg_top AND signal_bar.close > fvg_bottom → Long.
 *   - Bearish FVG: mirror.
 *
 * Lookahead-safe: signal-bar `len-2` cannot participate in FVG anchor
 * (k+2 ≤ signal_idx - 1 ⇒ k ≤ signal_idx - 3).
 */
import type { Candle } from "@/utils/indicators";
import type { VoterSide } from "@/utils/regimeVoters/types";

export interface FvgParams {
  /** Bars back from signal-bar to scan for a 3-bar imbalance anchor. */
  fvgLookback: number;
  /** Minimum gap-width as fraction of zone bottom price. */
  fvgMinWidthPct: number;
  /** Minimum absolute impulse-bar body as fraction of its open. */
  fvgImpulseMinPct: number;
}

export function defaultFvgParams(): FvgParams {
  return {
    fvgLookback: 20,
    fvgMinWidthPct: 0.0015,
    fvgImpulseMinPct: 0.005,
  };
}

export function computeSmcFvgVote(
  candles: Candle[],
  params: FvgParams = defaultFvgParams(),
): VoterSide {
  if (params.fvgLookback <= 0 || candles.length < params.fvgLookback + 3)
    return null;
  if (!Number.isFinite(params.fvgMinWidthPct) || params.fvgMinWidthPct < 0)
    return null;
  if (!Number.isFinite(params.fvgImpulseMinPct) || params.fvgImpulseMinPct < 0)
    return null;

  const signalIdx = candles.length - 2;
  const signalBar = candles[signalIdx]!;
  if (
    !Number.isFinite(signalBar.low) ||
    !Number.isFinite(signalBar.high) ||
    !Number.isFinite(signalBar.close) ||
    !Number.isFinite(signalBar.open)
  ) {
    return null;
  }

  // k + 2 ≤ signal_idx - 1 ⇒ k ≤ signal_idx - 3.
  if (signalIdx < 3) return null;
  const endInclusive = signalIdx - 3;
  const start = Math.max(0, signalIdx - params.fvgLookback);
  if (start > endInclusive) return null;

  // Walk newest to oldest — bias toward freshest gap.
  for (let k = endInclusive; k >= start; k--) {
    const barK = candles[k]!;
    const barM = candles[k + 1]!;
    const barP = candles[k + 2]!;
    if (
      !Number.isFinite(barK.high) ||
      !Number.isFinite(barK.low) ||
      !Number.isFinite(barM.open) ||
      !Number.isFinite(barM.close) ||
      !Number.isFinite(barP.high) ||
      !Number.isFinite(barP.low)
    ) {
      continue;
    }
    if (barM.open <= 0) continue;
    const impulseBody = Math.abs(barM.close - barM.open) / barM.open;
    if (!Number.isFinite(impulseBody) || impulseBody < params.fvgImpulseMinPct)
      continue;

    // Bullish FVG.
    if (barP.low > barK.high) {
      const fvgBottom = barK.high;
      const fvgTop = barP.low;
      if (fvgBottom <= 0) continue;
      const widthPct = (fvgTop - fvgBottom) / fvgBottom;
      if (!Number.isFinite(widthPct) || widthPct < params.fvgMinWidthPct)
        continue;
      if (signalBar.low <= fvgTop && signalBar.close > fvgBottom) {
        return "long";
      }
      continue;
    }
    // Bearish FVG.
    if (barP.high < barK.low) {
      const fvgBottom = barP.high;
      const fvgTop = barK.low;
      if (fvgBottom <= 0) continue;
      const widthPct = (fvgTop - fvgBottom) / fvgBottom;
      if (!Number.isFinite(widthPct) || widthPct < params.fvgMinWidthPct)
        continue;
      if (signalBar.high >= fvgBottom && signalBar.close < fvgTop) {
        return "short";
      }
      continue;
    }
  }
  return null;
}
