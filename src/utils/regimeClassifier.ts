/**
 * Market Regime Classifier.
 *
 * Labels each historical window as one of:
 *   - "calm"            : low realized vol, neutral funding
 *   - "leverage-bull"   : sustained +funding, rising OI, long-crowded
 *   - "leverage-bear"   : sustained -funding, rising OI, short-crowded
 *   - "trend-up"        : clear price drift up, vol mid, funding moderate+
 *   - "trend-down"      : clear drift down, funding negative/neutral
 *   - "chop"            : mixed signals, no clear regime
 *
 * This helps answer: "given the current regime, which of my strategies
 * are historically positive?" Instead of always running the whole ensemble,
 * we can let the regime gate strategy activation.
 */

import type { Candle } from "@/utils/indicators";
import { sma, atr } from "@/utils/indicators";
import type { FundingEvent } from "@/utils/fundingRate";

export type Regime =
  | "calm"
  | "leverage-bull"
  | "leverage-bear"
  | "trend-up"
  | "trend-down"
  | "chop";

export interface RegimeWindow {
  startTime: number;
  endTime: number;
  regime: Regime;
  realizedVolPct: number;
  trendPct: number; // return over window
  fundingMean: number;
  fundingPositivePct: number;
}

export interface RegimeClassifierConfig {
  windowHours: number; // 168 = 1 week by default
  lowVolThreshold: number; // e.g. 0.004 per hour realized vol = calm
  highVolThreshold: number; // e.g. 0.02 per hour = regime-break territory
  strongTrendPct: number; // e.g. 0.08 = 8% week-over-week is trending
  highFundingMean: number; // 0.0003 = sustained leverage-bull
  highFundingPositivePct: number; // 0.8 = 80% of periods positive
}

export const DEFAULT_REGIME_CONFIG: RegimeClassifierConfig = {
  windowHours: 168,
  lowVolThreshold: 0.004,
  highVolThreshold: 0.02,
  strongTrendPct: 0.08,
  highFundingMean: 0.0003,
  highFundingPositivePct: 0.8,
};

function stdevLogRet(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1]!.close > 0 && candles[i]!.close > 0) {
      rets.push(Math.log(candles[i]!.close / candles[i - 1]!.close));
    }
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const v =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    Math.max(1, rets.length);
  return Math.sqrt(v);
}

export function classifyRegimes(
  candles: Candle[],
  funding: FundingEvent[],
  config: RegimeClassifierConfig = DEFAULT_REGIME_CONFIG,
): RegimeWindow[] {
  const out: RegimeWindow[] = [];
  const sortedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);
  const sortedFunding = [...funding].sort(
    (a, b) => a.fundingTime - b.fundingTime,
  );

  let i = 0;
  while (i + config.windowHours < sortedCandles.length) {
    const window = sortedCandles.slice(i, i + config.windowHours);
    const startTime = window[0]!.openTime;
    const endTime = window[window.length - 1]!.closeTime;

    const realizedVol = stdevLogRet(window);
    const trend =
      (window[window.length - 1]!.close - window[0]!.close) / window[0]!.close;
    const windowFunding = sortedFunding.filter(
      (f) => f.fundingTime >= startTime && f.fundingTime <= endTime,
    );
    const fundingMean =
      windowFunding.reduce((s, f) => s + f.fundingRate, 0) /
      Math.max(1, windowFunding.length);
    const fundingPosPct =
      windowFunding.filter((f) => f.fundingRate > 0).length /
      Math.max(1, windowFunding.length);

    let regime: Regime = "chop";
    if (
      realizedVol < config.lowVolThreshold &&
      Math.abs(trend) < config.strongTrendPct * 0.4
    ) {
      regime = "calm";
    } else if (
      fundingMean > config.highFundingMean &&
      fundingPosPct > config.highFundingPositivePct
    ) {
      regime = "leverage-bull";
    } else if (
      fundingMean < -config.highFundingMean &&
      fundingPosPct < 1 - config.highFundingPositivePct
    ) {
      regime = "leverage-bear";
    } else if (trend > config.strongTrendPct) {
      regime = "trend-up";
    } else if (trend < -config.strongTrendPct) {
      regime = "trend-down";
    }

    out.push({
      startTime,
      endTime,
      regime,
      realizedVolPct: realizedVol,
      trendPct: trend,
      fundingMean,
      fundingPositivePct: fundingPosPct,
    });
    i += config.windowHours;
  }

  return out;
}

/**
 * Computes the fraction of each regime in the sample. Useful to check
 * whether our backtest is regime-representative.
 */
export function regimeMix(windows: RegimeWindow[]): Record<Regime, number> {
  const counts: Record<Regime, number> = {
    calm: 0,
    "leverage-bull": 0,
    "leverage-bear": 0,
    "trend-up": 0,
    "trend-down": 0,
    chop: 0,
  };
  for (const w of windows) counts[w.regime]++;
  const total = windows.length || 1;
  return {
    calm: counts.calm / total,
    "leverage-bull": counts["leverage-bull"] / total,
    "leverage-bear": counts["leverage-bear"] / total,
    "trend-up": counts["trend-up"] / total,
    "trend-down": counts["trend-down"] / total,
    chop: counts.chop / total,
  };
}

/**
 * Given a set of regime windows and trade timestamps, returns the PnL
 * grouped by regime. This answers: "in calm regimes, does Champion lose
 * money? In trend-up regimes does Funding-Carry lose?"
 */
export function pnlByRegime(
  windows: RegimeWindow[],
  trades: { time: number; pnlPct: number }[],
): Record<Regime, { n: number; meanPct: number; totalPct: number }> {
  const sortedW = [...windows].sort((a, b) => a.startTime - b.startTime);
  const result: Record<
    Regime,
    { n: number; meanPct: number; totalPct: number }
  > = {
    calm: { n: 0, meanPct: 0, totalPct: 0 },
    "leverage-bull": { n: 0, meanPct: 0, totalPct: 0 },
    "leverage-bear": { n: 0, meanPct: 0, totalPct: 0 },
    "trend-up": { n: 0, meanPct: 0, totalPct: 0 },
    "trend-down": { n: 0, meanPct: 0, totalPct: 0 },
    chop: { n: 0, meanPct: 0, totalPct: 0 },
  };
  const sums: Record<Regime, number> = {
    calm: 0,
    "leverage-bull": 0,
    "leverage-bear": 0,
    "trend-up": 0,
    "trend-down": 0,
    chop: 0,
  };
  for (const t of trades) {
    // Binary search for the window containing this time
    let lo = 0,
      hi = sortedW.length - 1,
      idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedW[mid]!.startTime > t.time) hi = mid - 1;
      else if (sortedW[mid]!.endTime < t.time) lo = mid + 1;
      else {
        idx = mid;
        break;
      }
    }
    if (idx < 0) continue;
    const regime = sortedW[idx]!.regime;
    result[regime].n++;
    sums[regime] += t.pnlPct;
    result[regime].totalPct = sums[regime];
  }
  for (const r of Object.keys(result) as Regime[]) {
    result[r].meanPct = result[r].n > 0 ? sums[r] / result[r].n : 0;
    // totalPct as compounded: (1+r1)(1+r2)...-1 would be nicer but sum is ok for log
  }
  return result;
}
// unused atr reference for now — keep import to preserve API surface
void atr;
void sma;
