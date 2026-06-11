/**
 * 2026-05-15 TS port of `engine-rust/ftmo-engine-core/src/signals_bb_zscore_mr.rs`
 * (feature/r28-deploy branch).
 *
 * Bollinger-Band Z-score Mean-Reversion voter — independent voter for
 * `RegimeConfluence`. See Rust source for full signal-contract docs.
 *
 * Long-trigger:
 *   1. Recent z-extreme: there exists a bar k in
 *      `[trigger_idx - lookBackBars, trigger_idx]` whose Z[k] ≤ -zThreshold.
 *   2. Cross-back-above-lower-BB on the signal bar:
 *      close[i-2] < lower[i-2] AND close[i-1] ≥ lower[i-1].
 *      (Series indexing follows Rust: signal_idx = candles.len() - 2.)
 *   3. Recovery cap: Z[trigger_idx] ≤ zRecoverCap (default 0.0).
 *
 * Short-trigger: mirror.
 *
 * Lookahead-safe: reads exclusively `candles[0 .. signal_idx]`. Entry bar
 * `candles[len - 1]` is never read.
 */
import type { Candle } from "@/utils/indicators";
import { sma } from "@/utils/indicators";
import { rollingStd } from "@/utils/regimeVoters/types";
import type { VoterSide } from "@/utils/regimeVoters/types";

export interface BollingerZScoreSource {
  /** SMA / std rolling window length (bars). Default 20. */
  bbPeriod: number;
  /** Band width: lower = mean - mult × std. Default 2.0. */
  bbMult: number;
  /** Minimum |Z| at the look-back peak required to arm the signal. Default 2.0. */
  zThreshold: number;
  /** Look-back window for the z-extreme. Default 5. */
  lookBackBars: number;
  /** Recovery cap on the signal bar's z. Default 0.0. */
  zRecoverCap: number;
  /** Minimum std / signal_close ratio. Default 5bp = 0.0005. */
  minStdPct: number;
}

export function defaultBbZScoreSource(): BollingerZScoreSource {
  return {
    bbPeriod: 20,
    bbMult: 2.0,
    zThreshold: 2.0,
    lookBackBars: 5,
    zRecoverCap: 0.0,
    minStdPct: 0.0005,
  };
}

/**
 * Pure vote helper — produces the BB-Z direction or null.
 *
 * Rust convention: candles slice contains the entry bar in slot
 * `len - 1`. Signal bar is `len - 2`.
 */
export function computeBbZScoreVote(
  candles: Candle[],
  src: BollingerZScoreSource = defaultBbZScoreSource(),
): VoterSide {
  if (src.bbPeriod <= 0 || src.bbMult <= 0 || src.zThreshold <= 0) return null;
  if (!Number.isFinite(src.bbMult) || !Number.isFinite(src.zThreshold))
    return null;
  const period = src.bbPeriod | 0;
  if (candles.length < period + 2) return null;

  const signalIdx = candles.length - 2;
  const prevSignalIdx = signalIdx - 1;
  if (prevSignalIdx < 0) return null;
  const lb = src.lookBackBars | 0;

  const closes = candles.map((c) => c.close);
  const smaSeries = sma(closes, period);
  const stdSeries = rollingStd(closes, period);

  const meanNow = smaSeries[signalIdx];
  const stdNow = stdSeries[signalIdx];
  const meanPrev = smaSeries[prevSignalIdx];
  const stdPrev = stdSeries[prevSignalIdx];

  if (meanNow == null || stdNow == null || meanPrev == null || stdPrev == null)
    return null;
  if (!Number.isFinite(meanNow) || !Number.isFinite(stdNow)) return null;

  const signalClose = closes[signalIdx]!;
  const prevClose = closes[prevSignalIdx]!;
  if (!Number.isFinite(signalClose) || !Number.isFinite(prevClose)) return null;
  if (signalClose === 0) return null;

  const stdRatioNow = stdNow / Math.abs(signalClose);
  if (stdRatioNow < src.minStdPct) return null;
  if (stdPrev <= 0) return null;

  const lowerNow = meanNow - src.bbMult * stdNow;
  const upperNow = meanNow + src.bbMult * stdNow;
  const lowerPrev = meanPrev - src.bbMult * stdPrev;
  const upperPrev = meanPrev + src.bbMult * stdPrev;

  const zNow = (signalClose - meanNow) / stdNow;
  if (!Number.isFinite(zNow)) return null;

  // Look-back z-extreme scan.
  const lbStart = Math.max(0, signalIdx - lb);
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let k = lbStart; k <= signalIdx; k++) {
    const m = smaSeries[k];
    const s = stdSeries[k];
    if (m == null || s == null) continue;
    if (s <= 0 || !Number.isFinite(s)) continue;
    const z = (closes[k]! - m) / s;
    if (!Number.isFinite(z)) continue;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // Long-trigger.
  const longExtreme = minZ <= -src.zThreshold;
  const longCross = prevClose < lowerPrev && signalClose >= lowerNow;
  const longRecover = zNow <= src.zRecoverCap;
  if (longExtreme && longCross && longRecover) return "long";

  // Short-trigger: mirror.
  const shortExtreme = maxZ >= src.zThreshold;
  const shortCross = prevClose > upperPrev && signalClose <= upperNow;
  const shortRecover = zNow >= -src.zRecoverCap;
  if (shortExtreme && shortCross && shortRecover) return "short";

  return null;
}
