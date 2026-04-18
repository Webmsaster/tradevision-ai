/**
 * Rolling-window Deflated Sharpe Ratio.
 *
 * Instead of computing DSR over the full sample, we compute it over sliding
 * windows (e.g. last 90 trades or last 30 days). This answers: "is my edge
 * DURABLE or is it only from one lucky period?"
 *
 * A strategy whose rolling DSR stays above 0.95 for most windows is
 * genuinely robust. One that passes overall but has many <0.5 windows is
 * bouncing around — likely regime-dependent.
 */

import { computeDeflatedSharpe } from "@/utils/deflatedSharpe";

export interface RollingDsrInput {
  returnsPct: number[];
  trialsTried: number;
  periodsPerYear?: number;
  windowBars: number;
  stepBars: number;
}

export interface RollingDsrPoint {
  windowEnd: number; // index into returns
  sharpe: number;
  deflatedSharpe: number;
  n: number;
}

export interface RollingDsrReport {
  points: RollingDsrPoint[];
  meanDsr: number;
  minDsr: number;
  maxDsr: number;
  share95: number; // fraction of windows with DSR > 0.95
  share80: number;
  share50: number;
}

export function computeRollingDsr(input: RollingDsrInput): RollingDsrReport {
  const points: RollingDsrPoint[] = [];
  for (
    let end = input.windowBars;
    end <= input.returnsPct.length;
    end += input.stepBars
  ) {
    const window = input.returnsPct.slice(end - input.windowBars, end);
    const d = computeDeflatedSharpe({
      returnsPct: window,
      trialsTried: input.trialsTried,
      periodsPerYear: input.periodsPerYear,
    });
    points.push({
      windowEnd: end,
      sharpe: d.sharpe,
      deflatedSharpe: d.deflatedSharpe,
      n: d.n,
    });
  }
  if (points.length === 0) {
    return {
      points: [],
      meanDsr: 0,
      minDsr: 0,
      maxDsr: 0,
      share95: 0,
      share80: 0,
      share50: 0,
    };
  }
  const dsrs = points.map((p) => p.deflatedSharpe);
  const meanDsr = dsrs.reduce((a, b) => a + b, 0) / dsrs.length;
  return {
    points,
    meanDsr,
    minDsr: Math.min(...dsrs),
    maxDsr: Math.max(...dsrs),
    share95: dsrs.filter((d) => d >= 0.95).length / dsrs.length,
    share80: dsrs.filter((d) => d >= 0.8).length / dsrs.length,
    share50: dsrs.filter((d) => d >= 0.5).length / dsrs.length,
  };
}
