/**
 * Volatility-Regime Filter.
 *
 * Research basis: Bianchi, Babiak, Dickerson (2024) "Trading Volatility
 * Regimes in Crypto" — Journal of Financial Econometrics. Finding: momentum
 * and hour-of-day edges concentrate in the MIDDLE vol quartile. Low-vol is
 * noise, high-vol is regime-change (mean-reversion dominates).
 *
 * Rule: compute rolling realized-volatility (stdev of 1h log-returns over
 * 24h). Keep a trailing 90-day percentile ranking. Trade the strategy only
 * when current RV is in [minPct, maxPct] percentile (e.g. 30-70).
 *
 * Can be layered on top of any existing strategy as a gate.
 */

import type { Candle } from "@/utils/indicators";

export interface VolRegimeConfig {
  /** Window for realized-volatility calc, in 1h bars (default 24 = 1 day). */
  rvWindowBars: number;
  /** Rolling window for percentile calc, in bars (default 2160 = 90d on 1h). */
  percentileWindowBars: number;
  /** Keep signals in this percentile range (e.g. 0.30 - 0.70). */
  minPercentile: number;
  maxPercentile: number;
}

export const DEFAULT_VOL_REGIME_CONFIG: VolRegimeConfig = {
  rvWindowBars: 24,
  percentileWindowBars: 2160,
  minPercentile: 0.3,
  maxPercentile: 0.7,
};

export interface VolRegimeBar {
  time: number;
  realizedVol: number; // stdev of last N log-returns
  percentile: number | null; // rank in trailing window, 0..1
  inRegime: boolean;
}

/**
 * Returns per-bar vol-regime classification. `inRegime === true` means the
 * current realized vol is in the configured percentile band, so the
 * underlying strategy signal should be ACTED on; otherwise skip.
 */
export function classifyVolRegime(
  candles: Candle[],
  config: VolRegimeConfig = DEFAULT_VOL_REGIME_CONFIG,
): VolRegimeBar[] {
  const out: VolRegimeBar[] = new Array(candles.length);

  // Log-returns
  const logRet = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0 && candles[i].close > 0) {
      logRet[i] = Math.log(candles[i].close / candles[i - 1].close);
    }
  }

  // Rolling RV (stdev over last rvWindowBars)
  const rv = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - config.rvWindowBars + 1);
    const window = logRet.slice(start, i + 1);
    const n = window.length;
    if (n < 2) {
      rv[i] = 0;
      continue;
    }
    const mean = window.reduce((a, b) => a + b, 0) / n;
    const variance =
      window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    rv[i] = Math.sqrt(variance);
  }

  // Rolling percentile rank
  for (let i = 0; i < candles.length; i++) {
    if (i < config.percentileWindowBars) {
      out[i] = {
        time: candles[i].openTime,
        realizedVol: rv[i],
        percentile: null,
        inRegime: false,
      };
      continue;
    }
    const sample = rv.slice(i - config.percentileWindowBars + 1, i + 1);
    let below = 0;
    for (const v of sample) if (v < rv[i]) below++;
    const pct = below / sample.length;
    out[i] = {
      time: candles[i].openTime,
      realizedVol: rv[i],
      percentile: pct,
      inRegime: pct >= config.minPercentile && pct <= config.maxPercentile,
    };
  }
  return out;
}

/**
 * Convenience: given candles + a function that emits 0/1 per bar ("should
 * I take this bar's signal?"), returns a masked version that also respects
 * the vol regime.
 */
export function applyVolRegimeMask(
  candles: Candle[],
  signal: boolean[],
  config: VolRegimeConfig = DEFAULT_VOL_REGIME_CONFIG,
): boolean[] {
  const regime = classifyVolRegime(candles, config);
  return signal.map((s, i) => s && regime[i]?.inRegime === true);
}
