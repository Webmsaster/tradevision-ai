/**
 * Strategy Health Monitor.
 *
 * Compares a strategy's RECENT performance (last N trades) to its
 * LIFETIME performance. If the rolling Sharpe drops below a threshold,
 * flag the strategy for review — live deployment should pause that
 * strategy until rolling Sharpe recovers.
 *
 * Thresholds (based on iter 3 rolling-DSR analysis):
 *   - HEALTHY: recent Sharpe > 0.8 × lifetime Sharpe
 *   - WATCH:   0.3 × lifetime < recent Sharpe < 0.8 × lifetime
 *   - PAUSE:   recent Sharpe < 0.3 × lifetime (or negative)
 */

export interface StrategyHealthInput {
  strategyName: string;
  allReturns: number[];
  recentWindow: number; // e.g. 30 trades
}

export interface StrategyHealthReport {
  strategyName: string;
  lifetimeN: number;
  recentN: number;
  lifetimeSharpe: number;
  recentSharpe: number;
  ratio: number; // recent / lifetime
  status: "healthy" | "watch" | "pause";
  reason: string;
}

function sharpeOf(returns: number[], periodsPerYear = 250): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const v =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length;
  const sd = Math.sqrt(v);
  return sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;
}

export function checkStrategyHealth(
  input: StrategyHealthInput,
  periodsPerYear = 250,
): StrategyHealthReport {
  const { allReturns, recentWindow, strategyName } = input;
  const recent = allReturns.slice(-recentWindow);
  const lifetime = sharpeOf(allReturns, periodsPerYear);
  const recentSh = sharpeOf(recent, periodsPerYear);
  const ratio = lifetime > 0 ? recentSh / lifetime : 0;

  let status: StrategyHealthReport["status"] = "healthy";
  let reason = "Recent Sharpe tracks lifetime — all good";
  if (recentSh < 0 || ratio < 0.3) {
    status = "pause";
    reason = `Recent Sharpe ${recentSh.toFixed(2)} is ${ratio < 0 ? "negative" : "far below"} lifetime ${lifetime.toFixed(2)} — PAUSE`;
  } else if (ratio < 0.8) {
    status = "watch";
    reason = `Recent Sharpe ${recentSh.toFixed(2)} weaker than lifetime ${lifetime.toFixed(2)} (${(ratio * 100).toFixed(0)}%) — WATCH`;
  }

  return {
    strategyName,
    lifetimeN: allReturns.length,
    recentN: recent.length,
    lifetimeSharpe: lifetime,
    recentSharpe: recentSh,
    ratio,
    status,
    reason,
  };
}
