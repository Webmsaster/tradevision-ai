import type {
  Trade,
  TradeStats,
  EquityCurvePoint,
  PerformanceByTime,
} from '@/types/trade';

/**
 * Calculate PnL and PnL percentage for a trade based on direction, prices,
 * quantity, leverage, and fees.
 */
export function calculatePnl(
  trade: Omit<Trade, 'id' | 'pnl' | 'pnlPercent'>
): { pnl: number; pnlPercent: number } {
  const { direction, entryPrice, exitPrice, quantity, leverage, fees } = trade;

  // quantity = total units in the position (full exposure).
  // Leverage only affects the margin (collateral) required, not the raw PnL.
  let pnl: number;
  if (direction === 'long') {
    pnl = (exitPrice - entryPrice) * quantity - fees;
  } else {
    pnl = (entryPrice - exitPrice) * quantity - fees;
  }

  // pnlPercent = return on margin (capital actually deployed).
  // margin = positionValue / leverage
  const positionValue = entryPrice * quantity;
  const margin = positionValue / (leverage || 1);
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
  const losses = trades.filter((t) => t.pnl <= 0);

  const avgWin =
    wins.length > 0
      ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length
      : 0;

  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length)
      : 0;

  return { avgWin, avgLoss };
}

/**
 * Calculate the risk/reward ratio (average win / average loss).
 * Returns 0 if there are no losing trades or no winning trades.
 */
export function calculateRiskReward(trades: Trade[]): number {
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
  if (avgLoss === 0) return 0;
  return avgWin / avgLoss;
}

/**
 * Calculate expectancy: the expected value per trade.
 * Formula: (winRate/100 * avgWin) - (lossRate/100 * avgLoss)
 */
export function calculateExpectancy(trades: Trade[]): number {
  if (trades.length === 0) return 0;

  const winRate = calculateWinRate(trades) / 100;
  const lossRate = 1 - winRate;
  const { avgWin, avgLoss } = calculateAvgWinLoss(trades);

  return winRate * avgWin - lossRate * avgLoss;
}

/**
 * Sort trades chronologically by exit date.
 */
function sortByExitDate(trades: Trade[]): Trade[] {
  return [...trades].sort(
    (a, b) => new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime()
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

    // Calculate drawdown as percentage of peak.
    // When peak <= 0 (all trades are losses), use absolute equity as reference.
    if (drawdown > 0) {
      const reference = peak > 0 ? peak : Math.abs(equity);
      const drawdownPercent = reference > 0 ? (drawdown / reference) * 100 : 0;
      if (drawdownPercent > maxDrawdownPercent) {
        maxDrawdownPercent = Math.min(drawdownPercent, 100);
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
    } else {
      currentLossStreak++;
      currentWinStreak = 0;

      if (currentLossStreak > longestLossStreak) {
        longestLossStreak = currentLossStreak;
      }
    }
  }

  return { longestWinStreak, longestLossStreak };
}

/**
 * Calculate the annualized Sharpe ratio of trade returns.
 *
 * Uses each trade's PnL as the return for that period:
 *   Sharpe = (mean return / std deviation of returns) * sqrt(252)
 *
 * The sqrt(252) factor is a standard annualization assuming 252 trading days.
 * Returns 0 if there are fewer than 2 trades or if the standard deviation is 0.
 */
export function calculateSharpeRatio(trades: Trade[]): number {
  if (trades.length < 2) return 0;

  const returns = trades.map((t) => t.pnl);

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Population standard deviation is used here. For sample std dev you would
  // divide by (n - 1), but for Sharpe ratio on the full trade set, population
  // is the standard convention in most trading analytics tools.
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const sharpe = (mean / stdDev) * Math.sqrt(252);
  return sharpe;
}

/**
 * Group trades by the day of the week of their entry date and compute
 * performance stats for each group.
 */
export function calculatePerformanceByDayOfWeek(
  trades: Trade[]
): PerformanceByTime[] {
  if (trades.length === 0) return [];

  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  const groups: Map<number, Trade[]> = new Map();

  for (const trade of trades) {
    const day = new Date(trade.entryDate).getDay();
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
      label: dayNames[day],
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
  trades: Trade[]
): PerformanceByTime[] {
  if (trades.length === 0) return [];

  const groups: Map<number, Trade[]> = new Map();

  for (const trade of trades) {
    const hour = new Date(trade.entryDate).getHours();
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
      label: `${hour.toString().padStart(2, '0')}:00`,
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
    return sum + (exit - entry);
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

  // Find best and worst trades by PnL
  const bestTrade = trades.reduce<Trade>((best, t) =>
    t.pnl > best.pnl ? t : best,
    trades[0]
  );

  const worstTrade = trades.reduce<Trade>((worst, t) =>
    t.pnl < worst.pnl ? t : worst,
    trades[0]
  );

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
