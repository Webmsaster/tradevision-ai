import type {
  Trade,
  TradeStats,
  EquityCurvePoint,
  PerformanceByTime,
} from "@/types/trade";
import { DAYS_OF_WEEK } from "@/lib/constants";

/**
 * Single source of truth for leverage validation. A leverage value is valid
 * iff it's a finite positive number. Anything else (NaN, 0, negative,
 * Infinity) falls back to 1 so calculations stay defined.
 *
 * Round 54: lift the previous `leverage || 1` shortcut into a named helper
 * so both calculatePnl and the form/import boundaries reach the same
 * conclusion. UI layers can use this to flag a "data quality" badge when
 * the fallback fires.
 */
export function validateLeverage(n: unknown): {
  leverage: number;
  fallback: boolean;
} {
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    return { leverage: n, fallback: false };
  }
  return { leverage: 1, fallback: true };
}

// Lazy once-per-session warning so we don't spam the console when an
// imported CSV has many bad rows.
let _leverageWarningEmitted = false;
function _warnLeverageFallbackOnce(): void {
  if (_leverageWarningEmitted) return;
  _leverageWarningEmitted = true;
  if (typeof console !== "undefined") {
    console.warn(
      "[calculations] One or more trades had a missing/invalid leverage; falling back to 1x. " +
        "Validate your CSV import / TradeForm input.",
    );
  }
}

/**
 * Calculate PnL and PnL percentage for a trade based on direction, prices,
 * quantity, leverage, and fees.
 */
export function calculatePnl(trade: Omit<Trade, "id" | "pnl" | "pnlPercent">): {
  pnl: number;
  pnlPercent: number;
} {
  const { direction, entryPrice, exitPrice, quantity, fees } = trade;

  // quantity = total units in the position (full exposure).
  // Leverage only affects the margin (collateral) required, not the raw PnL.
  let pnl: number;
  if (direction === "long") {
    pnl = (exitPrice - entryPrice) * quantity - fees;
  } else {
    pnl = (entryPrice - exitPrice) * quantity - fees;
  }

  // pnlPercent = return on margin (capital actually deployed).
  // margin = positionValue / leverage
  const { leverage, fallback } = validateLeverage(trade.leverage);
  if (fallback) _warnLeverageFallbackOnce();
  const positionValue = entryPrice * quantity;
  const margin = positionValue / leverage;
  const pnlPercent = margin !== 0 ? (pnl / margin) * 100 : 0;

  return { pnl, pnlPercent };
}

/**
 * Calculate the win rate as a percentage (0-100).
 * A win is defined as a trade with pnl > 0.
 */
export function calculateWinRate(trades: Trade[]): number {
  if (trades.length === 0) return 0;

  const wins = trades.filter((t) => t.pnl > 0).length;
  return (wins / trades.length) * 100;
}

/**
 * Calculate the average PnL of winning trades and the average absolute PnL
 * of losing trades.
 */
export function calculateAvgWinLoss(trades: Trade[]): {
  avgWin: number;
  avgLoss: number;
} {
  const wins = trades.filter((t) => t.pnl > 0);
  // Break-even (pnl === 0) is neither win nor loss — consistent with calculateWinRate.
  const losses = trades.filter((t) => t.pnl < 0);

  const avgWin =
    wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;

  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length)
      : 0;

  return { avgWin, avgLoss };
}

/**
 * Calculate the risk/reward ratio (average win / average loss).
 * Returns null when the ratio is undefined (no losses but wins → would be
 * Infinity) so callers can render an explicit "N/A" instead of carrying
 * a non-finite number through downstream math (formatting, charts, AI).
 * Returns 0 if there are neither winning nor losing trades.
 */
export function calculateRiskReward(trades: Trade[]): number | null {
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
  if (avgLoss === 0) {
    // Wins but no losses → undefined R:R; signal explicitly via null.
    if (avgWin > 0) return null;
    return 0;
  }
  const value = avgWin / avgLoss;
  // Defensive: if FP arithmetic still produces a non-finite value, surface null.
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Calculate expectancy: the expected value per trade.
 * Formula: (winRate * avgWin) - (lossRate * avgLoss), where rates count
 * BE-trades as NEITHER (consistent with calculateWinRate / calculateAvgWinLoss).
 */
export function calculateExpectancy(trades: Trade[]): number {
  if (trades.length === 0) return 0;

  // Phase 42 (R44-CALC-1): lossRate = losses / total directly. Was
  // `1 - winRate`, which folded BE-trades into the loss bucket and
  // overweighted avgLoss when many BE trades were present (4 wins / 2
  // losses / 4 BE used to yield lossRate=0.6 instead of 0.2).
  const total = trades.length;
  const winRate = trades.filter((t) => t.pnl > 0).length / total;
  const lossRate = trades.filter((t) => t.pnl < 0).length / total;
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);

  return winRate * avgWin - lossRate * avgLoss;
}

/**
 * Sort trades chronologically by exit date.
 */
function sortByExitDate(trades: Trade[]): Trade[] {
  return [...trades].sort(
    (a, b) => new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime(),
  );
}

/**
 * Calculate the maximum drawdown in absolute dollar terms and as a percentage
 * of the peak equity.
 *
 * Drawdown is the largest peak-to-trough decline in the running equity curve.
 * We compute running equity as cumulative PnL, and the drawdown percentage is
 * relative to the peak equity value at each point.
 */
export function calculateMaxDrawdown(trades: Trade[]): {
  maxDrawdown: number;
  maxDrawdownPercent: number;
} {
  if (trades.length === 0) return { maxDrawdown: 0, maxDrawdownPercent: 0 };

  const sorted = sortByExitDate(trades);

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const trade of sorted) {
    equity += trade.pnl;

    if (equity > peak) {
      peak = equity;
    }

    const drawdown = peak - equity;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }

    // Float-point tolerance: ignore sub-penny pseudo-drawdowns from cumulative
    // floating-point error (e.g. 0.1 + 0.2 - 0.3 ≈ 5.55e-17).
    // When peak <= 0 (all trades are losses), use absolute equity as reference.
    const FP_TOLERANCE = 1e-9;
    if (drawdown > FP_TOLERANCE) {
      const reference = peak > 0 ? peak : Math.abs(equity);
      const drawdownPercent = reference > 0 ? (drawdown / reference) * 100 : 0;
      if (drawdownPercent > maxDrawdownPercent) {
        // No silent cap — if real DD > 100% (loss exceeds peak), report it.
        maxDrawdownPercent = drawdownPercent;
      }
    }
  }

  return { maxDrawdown, maxDrawdownPercent };
}

/**
 * Build the equity curve: an array of data points with date, cumulative equity,
 * and current drawdown at each closed trade.
 */
export function calculateEquityCurve(trades: Trade[]): EquityCurvePoint[] {
  if (trades.length === 0) return [];

  const sorted = sortByExitDate(trades);

  let equity = 0;
  let peak = 0;
  const curve: EquityCurvePoint[] = [];

  for (const trade of sorted) {
    equity += trade.pnl;

    if (equity > peak) {
      peak = equity;
    }

    const drawdown = peak - equity;

    curve.push({
      date: trade.exitDate,
      equity,
      drawdown,
    });
  }

  return curve;
}

/**
 * Calculate the profit factor: gross profits / |gross losses|.
 * Returns Infinity if there are no losing trades (but there are winning trades).
 * Returns 0 if there are no trades or no winning trades.
 */
export function calculateProfitFactor(trades: Trade[]): number {
  if (trades.length === 0) return 0;

  let grossProfit = 0;
  let grossLoss = 0;

  for (const trade of trades) {
    if (trade.pnl > 0) {
      grossProfit += trade.pnl;
    } else {
      grossLoss += Math.abs(trade.pnl);
    }
  }

  if (grossLoss === 0) {
    return grossProfit > 0 ? Infinity : 0;
  }

  return grossProfit / grossLoss;
}

/**
 * Calculate the longest consecutive winning streak and losing streak.
 * Trades are sorted by exit date before evaluation.
 */
export function calculateStreaks(trades: Trade[]): {
  longestWinStreak: number;
  longestLossStreak: number;
} {
  if (trades.length === 0) return { longestWinStreak: 0, longestLossStreak: 0 };

  const sorted = sortByExitDate(trades);

  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;

  for (const trade of sorted) {
    if (trade.pnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > longestWinStreak) {
        longestWinStreak = currentWinStreak;
      }
    } else if (trade.pnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > longestLossStreak) {
        longestLossStreak = currentLossStreak;
      }
    }
    // Break-even trades (pnl === 0) do NOT break or extend either streak.
  }

  return { longestWinStreak, longestLossStreak };
}

/**
 * Trade-frequency-adjusted Sharpe proxy.
 *
 * NOTE: this is NOT the textbook Sharpe ratio (which is computed on a
 * regularly-spaced return series, e.g. daily closes). We compute a per-trade
 * Sharpe using each trade's `pnlPercent` and annualise it by sqrt(N), where
 * N = trades-per-year inferred from the actual exit-date span.
 *
 * Why this matters: the previous implementation hard-coded sqrt(252),
 * implicitly assuming each trade represents one trading day. A scalper who
 * places 10 trades/day and a swing trader who places 1/week would both get
 * the same scaling factor — wildly under-/over-stating their annualised
 * Sharpe by 5-10×.
 *
 * Implementation:
 *   - Use pnlPercent (return-based) so position size doesn't dominate.
 *   - tradesPerYear = trades.length / years-spanned (from first→last exit).
 *   - For very short spans (< ~36 days) the inferred frequency is noisy,
 *     so we fall back to sqrt(252) and warn via JSDoc — callers should
 *     treat the result as high-variance.
 *
 * Returns 0 for fewer than 2 trades, or when the std dev of returns is 0.
 */
export function calculateSharpeRatio(trades: Trade[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map((t) =>
    Number.isFinite(t.pnlPercent) ? t.pnlPercent : 0,
  );

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Population standard deviation (full-population convention).
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // FP-noise guard: identical-return series can produce stdDev ≈ 1e-15 from
  // round-off in the variance accumulator, blowing up mean/stdDev to a huge
  // bogus Sharpe. Treat anything below tolerance as zero.
  const FP_TOLERANCE = 1e-12;
  if (stdDev < FP_TOLERANCE) return 0;

  // Infer trades-per-year from the exit-date span.
  const exitTimes = trades
    .map((t) => new Date(t.exitDate).getTime())
    .filter((n) => Number.isFinite(n));

  let annualisationFactor = Math.sqrt(252); // sensible default
  if (exitTimes.length >= 2) {
    // Round 56 (R56-CAL-1): explicit min/max reduce instead of
    // `Math.max(...arr)` / `Math.min(...arr)`. Spread of >~10k items can
    // overflow the V8 argument stack on power-user backtest imports
    // (50k+ trades) — `RangeError: Maximum call stack size exceeded`.
    let mx = -Infinity;
    let mn = Infinity;
    for (const t of exitTimes) {
      if (t > mx) mx = t;
      if (t < mn) mn = t;
    }
    const spanMs = mx - mn;
    const years = spanMs / (365.25 * 24 * 60 * 60 * 1000);
    // Below ~36 days the inferred rate is too noisy; keep the default.
    if (years >= 0.1) {
      // Use exitTimes.length (the validated, finite-date count) — not
      // trades.length — so trades with malformed exitDates don't inflate
      // the inferred frequency.
      const tradesPerYear = exitTimes.length / Math.max(years, 1e-9);
      annualisationFactor = Math.sqrt(tradesPerYear);
    }
  }

  const sharpe = (mean / stdDev) * annualisationFactor;
  return sharpe;
}

/**
 * Group trades by the day of the week of their entry date and compute
 * performance stats for each group.
 */
export function calculatePerformanceByDayOfWeek(
  trades: Trade[],
): PerformanceByTime[] {
  if (trades.length === 0) return [];

  const dayNames = DAYS_OF_WEEK;
  const groups: Map<number, Trade[]> = new Map();

  // Phase 42 (R44-CALC-3): use UTC for time-of-week bucketing — Round 43
  // Phase 6 already moved aiAnalysis day/hour helpers to UTC; this kept
  // local time so detector insights ("Sunday underperforms") would
  // disagree with the dashboard heatmap for the same trade set.
  for (const trade of trades) {
    const day = new Date(trade.entryDate).getUTCDay();
    if (!groups.has(day)) {
      groups.set(day, []);
    }
    groups.get(day)!.push(trade);
  }

  const result: PerformanceByTime[] = [];

  // Iterate Monday (1) through Sunday (0) in proper weekly order
  const orderedDays = [1, 2, 3, 4, 5, 6, 0];

  for (const day of orderedDays) {
    const dayTrades = groups.get(day);
    if (!dayTrades || dayTrades.length === 0) continue;

    const totalPnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const wins = dayTrades.filter((t) => t.pnl > 0).length;

    result.push({
      label: dayNames[day]!,
      trades: dayTrades.length,
      winRate: (wins / dayTrades.length) * 100,
      avgPnl: totalPnl / dayTrades.length,
      totalPnl,
    });
  }

  return result;
}

/**
 * Group trades by the hour of the day (0-23) of their entry date and compute
 * performance stats for each group.
 */
export function calculatePerformanceByHour(
  trades: Trade[],
): PerformanceByTime[] {
  if (trades.length === 0) return [];

  const groups: Map<number, Trade[]> = new Map();

  // Phase 42 (R44-CALC-3): UTC bucketing for parity with aiAnalysis.
  for (const trade of trades) {
    const hour = new Date(trade.entryDate).getUTCHours();
    if (!groups.has(hour)) {
      groups.set(hour, []);
    }
    groups.get(hour)!.push(trade);
  }

  const result: PerformanceByTime[] = [];

  // Iterate hours 0 through 23 in order
  for (let hour = 0; hour < 24; hour++) {
    const hourTrades = groups.get(hour);
    if (!hourTrades || hourTrades.length === 0) continue;

    const totalPnl = hourTrades.reduce((sum, t) => sum + t.pnl, 0);
    const wins = hourTrades.filter((t) => t.pnl > 0).length;

    result.push({
      label: `${hour.toString().padStart(2, "0")}:00`,
      trades: hourTrades.length,
      winRate: (wins / hourTrades.length) * 100,
      avgPnl: totalPnl / hourTrades.length,
      totalPnl,
    });
  }

  return result;
}

/**
 * Calculate the average holding time across all trades in milliseconds.
 * Holding time = exitDate - entryDate for each trade.
 */
export function calculateAvgHoldTime(trades: Trade[]): number {
  if (trades.length === 0) return 0;

  const totalHoldTime = trades.reduce((sum, trade) => {
    const entry = new Date(trade.entryDate).getTime();
    const exit = new Date(trade.exitDate).getTime();
    return sum + Math.max(0, exit - entry);
  }, 0);

  return totalHoldTime / trades.length;
}

/**
 * Calculate all trading statistics and return a complete TradeStats object.
 * This is the primary entry point for the dashboard and reporting views.
 */
export function calculateAllStats(trades: Trade[]): TradeStats {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      riskReward: 0,
      expectancy: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      totalPnl: 0,
      bestTrade: null,
      worstTrade: null,
      longestWinStreak: 0,
      longestLossStreak: 0,
      avgHoldTime: 0,
    };
  }

  const winRate = calculateWinRate(trades);
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
  const riskReward = calculateRiskReward(trades);
  const expectancy = calculateExpectancy(trades);
  const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades);
  const profitFactor = calculateProfitFactor(trades);
  const sharpeRatio = calculateSharpeRatio(trades);
  const { longestWinStreak, longestLossStreak } = calculateStreaks(trades);
  const avgHoldTime = calculateAvgHoldTime(trades);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Find best and worst trades by PnL. Filter out NaN-PnL rows: a single
  // NaN trade poisons reduce() (any comparison with NaN is false) and would
  // make best/worst depend on iteration order. trades[] is non-empty here,
  // but validTrades may still be empty if every PnL is NaN.
  const validTrades = trades.filter((t) => Number.isFinite(t.pnl));
  const bestTrade =
    validTrades.length > 0
      ? validTrades.reduce<Trade>(
          (best, t) => (t.pnl > best.pnl ? t : best),
          validTrades[0]!,
        )
      : null;

  const worstTrade =
    validTrades.length > 0
      ? validTrades.reduce<Trade>(
          (worst, t) => (t.pnl < worst.pnl ? t : worst),
          validTrades[0]!,
        )
      : null;

  return {
    totalTrades: trades.length,
    winRate,
    avgWin,
    avgLoss,
    riskReward,
    expectancy,
    maxDrawdown,
    maxDrawdownPercent,
    profitFactor,
    sharpeRatio,
    totalPnl,
    bestTrade,
    worstTrade,
    longestWinStreak,
    longestLossStreak,
    avgHoldTime,
  };
}
