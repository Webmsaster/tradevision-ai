/**
 * Industry-standard performance metrics on a return-series.
 * Inputs are per-trade returns (decimal, e.g. 0.012 = +1.2%).
 */
export interface PerformanceMetrics {
  trades: number;
  totalReturnPct: number;
  winRate: number;
  profitFactor: number;
  avgReturnPct: number;
  stdDevPct: number;
  sharpe: number; // annualised; assumes returns are per-trade
  sortino: number; // downside-only std dev
  maxDrawdownPct: number;
  maxDrawdownDuration: number; // in trades
  calmar: number; // CAGR / maxDrawdown (approximate)
  expectancyR: number; // in R multiples if riskPerTrade provided
  equityCurve: number[]; // normalised to 1.0 starting equity
}

export interface MetricsInput {
  returnsPct: number[];
  periodsPerYear?: number; // e.g. number of expected trades per year; used for annualisation
  riskPerTradePct?: number; // stop-loss distance as fraction of capital; used for expectancy in R
}

/**
 * Computes Sharpe, Sortino, Calmar, max drawdown, profit factor, win rate and
 * an equity curve from a series of per-trade returns. Returns zeroed metrics
 * if the input is empty.
 */
export function computeMetrics({
  returnsPct,
  periodsPerYear = 252,
  riskPerTradePct = 0.01,
}: MetricsInput): PerformanceMetrics {
  const n = returnsPct.length;
  if (n === 0) {
    return {
      trades: 0,
      totalReturnPct: 0,
      winRate: 0,
      profitFactor: 0,
      avgReturnPct: 0,
      stdDevPct: 0,
      sharpe: 0,
      sortino: 0,
      maxDrawdownPct: 0,
      maxDrawdownDuration: 0,
      calmar: 0,
      expectancyR: 0,
      equityCurve: [1],
    };
  }

  // Equity curve (compounded)
  const equityCurve: number[] = [1];
  let equity = 1;
  for (const r of returnsPct) {
    equity *= 1 + r;
    equityCurve.push(equity);
  }
  const totalReturnPct = equity - 1;

  // Mean / std dev
  const avg = returnsPct.reduce((s, v) => s + v, 0) / n;
  const variance =
    returnsPct.reduce((s, v) => s + (v - avg) * (v - avg), 0) / n;
  const stdDev = Math.sqrt(variance);

  // Downside deviation (Sortino)
  const downside = returnsPct.filter((r) => r < 0);
  const downVar =
    downside.length > 0 ? downside.reduce((s, v) => s + v * v, 0) / n : 0;
  const downDev = Math.sqrt(downVar);

  const sharpe = stdDev > 0 ? (avg / stdDev) * Math.sqrt(periodsPerYear) : 0;
  const sortino = downDev > 0 ? (avg / downDev) * Math.sqrt(periodsPerYear) : 0;

  // Max drawdown & duration
  let peak = 1;
  let peakIdx = 0;
  let maxDd = 0;
  let maxDdDuration = 0;
  for (let i = 0; i < equityCurve.length; i++) {
    if (equityCurve[i]! > peak) {
      peak = equityCurve[i];
      peakIdx = i;
    }
    const dd = (peak - equityCurve[i]!) / peak;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdDuration = i - peakIdx;
    }
  }

  // Profit factor
  const grossWin = returnsPct.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossLoss = Math.abs(
    returnsPct.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const wins = returnsPct.filter((r) => r > 0).length;
  const winRate = wins / n;

  // Calmar (approx): CAGR / MDD
  const tradesPerYear = periodsPerYear;
  const years = n / tradesPerYear;
  const cagr = years > 0 ? Math.pow(equity, 1 / years) - 1 : 0;
  const calmar = maxDd > 0 ? cagr / maxDd : 0;

  // Expectancy in R multiples
  const expectancyR = riskPerTradePct > 0 ? avg / riskPerTradePct : 0;

  return {
    trades: n,
    totalReturnPct,
    winRate,
    profitFactor,
    avgReturnPct: avg,
    stdDevPct: stdDev,
    sharpe,
    sortino,
    maxDrawdownPct: maxDd,
    maxDrawdownDuration: maxDdDuration,
    calmar,
    expectancyR,
    equityCurve,
  };
}
