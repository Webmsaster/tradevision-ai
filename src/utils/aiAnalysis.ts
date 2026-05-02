import { Trade, AIInsight } from "@/types/trade";
import { v4 as uuidv4 } from "uuid";
import { DAYS_OF_WEEK } from "@/lib/constants";

function generateId(): string {
  return `insight-${uuidv4()}`;
}

// Phase 61 (R45-CC-M2): hoisted helper. The pattern
// `(a, b) => new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime()`
// appeared inline 6× across detectors with drift risk if a tie-breaker
// was added in only one place.
function compareByExitDate(a: Trade, b: Trade): number {
  return new Date(a.exitDate).getTime() - new Date(b.exitDate).getTime();
}

function getHoldTimeMs(trade: Trade): number {
  return Math.max(
    0,
    new Date(trade.exitDate).getTime() - new Date(trade.entryDate).getTime(),
  );
}

function getHourOfDay(dateStr: string): number {
  // Phase 6 (AI Bug 5/14): use UTC consistently — local-time would change
  // bucketing per-Browser timezone (Tokyo vs NYC see different patterns
  // for the same UTC trade) and cause SSR/CSR hydration mismatch.
  return new Date(dateStr).getUTCHours();
}

function getDayOfWeek(dateStr: string): number {
  // Phase 6 (AI Bug 5/14): same — UTC bucketing for day-of-week.
  return new Date(dateStr).getUTCDay();
}

/**
 * Detects revenge trading: after 2+ consecutive losses, position size increases by >50%.
 */
export function detectRevengeTrade(trades: Trade[]): AIInsight | null {
  if (trades.length < 3) return null;

  const sorted = [...trades].sort(compareByExitDate);

  for (let i = 2; i < sorted.length; i++) {
    const prev1 = sorted[i - 2];
    const prev2 = sorted[i - 1];
    const current = sorted[i];

    if (prev1!.pnl < 0 && prev2!.pnl < 0) {
      const prevAvgSize =
        (prev1!.quantity * prev1!.entryPrice +
          prev2!.quantity * prev2!.entryPrice) /
        2;
      const currentSize = current!.quantity * current!.entryPrice;

      // Guard against zero-cost reference (corrupt data, cash positions).
      // Without this, increasePercent becomes Infinity → "increased by Infinity%".
      if (prevAvgSize <= 0) continue;
      if (currentSize > prevAvgSize * 1.5) {
        const increasePercent = Math.round(
          ((currentSize - prevAvgSize) / prevAvgSize) * 100,
        );

        return {
          id: generateId(),
          type: "warning",
          title: "Revenge Trading Detected",
          description:
            `After consecutive losses on ${prev1!.pair} (${prev1!.pnl.toFixed(2)}) and ${prev2!.pair} (${prev2!.pnl.toFixed(2)}), ` +
            `your position size increased by ${increasePercent}% on your next trade (${current!.pair}). ` +
            `This pattern of increasing size after losses is a hallmark of revenge trading and often leads to even larger drawdowns. ` +
            `Consider stepping away after consecutive losses or enforcing a fixed position-sizing rule.`,
          severity: 8,
          relatedTrades: [prev1!.id, prev2!.id, current!.id],
          category: "revenge-trading",
        };
      }
    }
  }

  return null;
}

/**
 * Detects holding losers too long: losers held >2x longer than winners on average.
 */
export function detectHoldingLosers(trades: Trade[]): AIInsight | null {
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl < 0);

  if (winners.length < 2 || losers.length < 2) return null;

  const avgWinHoldTime =
    winners.reduce((sum, t) => sum + getHoldTimeMs(t), 0) / winners.length;
  const avgLossHoldTime =
    losers.reduce((sum, t) => sum + getHoldTimeMs(t), 0) / losers.length;

  if (avgWinHoldTime <= 0) return null;

  const ratio = avgLossHoldTime / avgWinHoldTime;

  if (ratio > 2) {
    const avgWinHours =
      Math.round((avgWinHoldTime / (1000 * 60 * 60)) * 10) / 10;
    const avgLossHours =
      Math.round((avgLossHoldTime / (1000 * 60 * 60)) * 10) / 10;
    const relatedLosers = losers
      .sort((a, b) => getHoldTimeMs(b) - getHoldTimeMs(a))
      .slice(0, 5)
      .map((t) => t.id);

    return {
      id: generateId(),
      type: "warning",
      title: "Holding Losers Too Long",
      description:
        `You are holding losing trades an average of ${avgLossHours} hours compared to ${avgWinHours} hours for winners ` +
        `(${ratio.toFixed(1)}x longer). This suggests you may be hoping losers will recover instead of cutting them quickly. ` +
        `Across ${losers.length} losing trades, this extended hold time is eroding your capital. ` +
        `Consider setting strict stop-losses and treating time-in-trade as a risk factor.`,
      severity: 7,
      relatedTrades: relatedLosers,
      category: "loss-aversion",
    };
  }

  return null;
}

/**
 * Detects worst performing hour of day with win rate < 30% (minimum 3 trades in that hour).
 */
export function detectTimePatterns(trades: Trade[]): AIInsight | null {
  if (trades.length < 3) return null;

  const hourStats: Record<
    number,
    { total: number; wins: number; tradeIds: string[] }
  > = {};

  for (const trade of trades) {
    const hour = getHourOfDay(trade.entryDate);
    if (!hourStats[hour]) {
      hourStats[hour] = { total: 0, wins: 0, tradeIds: [] };
    }
    hourStats[hour].total++;
    if (trade.pnl > 0) hourStats[hour].wins++;
    hourStats[hour].tradeIds.push(trade.id);
  }

  let worstHour: number | null = null;
  let worstWinRate = 1;

  for (const hourStr of Object.keys(hourStats)) {
    const hour = Number(hourStr);
    const stats = hourStats[hour];
    if (stats!.total < 3) continue;

    const winRate = stats!.wins / stats!.total;
    if (winRate < worstWinRate) {
      worstWinRate = winRate;
      worstHour = hour;
    }
  }

  if (worstHour === null || worstWinRate >= 0.3) return null;

  const stats = hourStats[worstHour];
  const winRatePercent = Math.round(worstWinRate * 100);
  const hourLabel = `${worstHour.toString().padStart(2, "0")}:00-${((worstHour + 1) % 24).toString().padStart(2, "0")}:00`;

  return {
    id: generateId(),
    type: "warning",
    title: "Poor Performance at Specific Time",
    description:
      `Your trades between ${hourLabel} have a win rate of only ${winRatePercent}% across ${stats!.total} trades. ` +
      `This is significantly below a healthy threshold. This time slot may coincide with low liquidity, ` +
      `high volatility events, or a period when your focus and decision-making are impaired. ` +
      `Consider avoiding trading during this hour or reducing your position size.`,
    severity: 5,
    relatedTrades: stats!.tradeIds.slice(0, 10),
    category: "time-patterns",
  };
}

/**
 * Detects overleveraging after winning streaks: after 3+ consecutive wins, leverage increases by >50%.
 */
export function detectOverleverageAfterWins(trades: Trade[]): AIInsight | null {
  if (trades.length < 4) return null;

  const sorted = [...trades].sort(compareByExitDate);

  for (let i = 3; i < sorted.length; i++) {
    const streak = [sorted[i - 3], sorted[i - 2], sorted[i - 1]];
    const allWins = streak.every((t) => t!.pnl > 0);

    if (!allWins) continue;

    // Phase 21 (AI Bug 4): skip if any trade in the streak OR the current
    // trade has no leverage recorded (mixed spot/margin). Spot trades default
    // to 1x and falsely flagged as 'low leverage' against 2x margin trades.
    if (sorted[i]!.leverage == null || streak.some((t) => t!.leverage == null))
      continue;
    const avgStreakLeverage =
      streak.reduce((sum, t) => sum + (t!.leverage ?? 1), 0) / streak.length;
    const nextLeverage = sorted[i]!.leverage ?? 1;

    if (avgStreakLeverage > 0 && nextLeverage > avgStreakLeverage * 1.5) {
      const increasePercent = Math.round(
        ((nextLeverage - avgStreakLeverage) / avgStreakLeverage) * 100,
      );

      return {
        id: generateId(),
        type: "warning",
        title: "Overleveraging After Winning Streak",
        description:
          `After ${streak.length} consecutive wins, you increased your leverage by ${increasePercent}% ` +
          `(from an average of ${avgStreakLeverage.toFixed(1)}x to ${nextLeverage}x on ${sorted[i]!.pair}). ` +
          `Winning streaks can create overconfidence, leading to outsized risk when the streak inevitably ends. ` +
          `Keep your leverage consistent regardless of recent results to protect against large drawdowns.`,
        severity: 7,
        relatedTrades: [...streak.map((t) => t!.id), sorted[i]!.id],
        category: "overleverage",
      };
    }
  }

  return null;
}

/**
 * Detects loss aversion: average loss amount > 1.5x average win amount
 * (cutting winners short while holding losers).
 */
export function detectLossAversion(trades: Trade[]): AIInsight | null {
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl < 0);

  if (winners.length < 3 || losers.length < 3) return null;

  const avgWin = winners.reduce((sum, t) => sum + t.pnl, 0) / winners.length;
  const avgLoss = Math.abs(
    losers.reduce((sum, t) => sum + t.pnl, 0) / losers.length,
  );

  if (avgWin <= 0) return null;

  const ratio = avgLoss / avgWin;

  if (ratio > 1.5) {
    return {
      id: generateId(),
      type: "warning",
      title: "Loss Aversion Detected",
      description:
        `Your average loss ($${avgLoss.toFixed(2)}) is ${ratio.toFixed(1)}x your average win ($${avgWin.toFixed(2)}). ` +
        `This indicates you are cutting winning trades short while allowing losing trades to run. ` +
        `Across ${losers.length} losses and ${winners.length} wins, this imbalance is significantly impacting your profitability. ` +
        `Consider using take-profit targets that are at least 1.5x your stop-loss distance to flip this ratio in your favor.`,
      severity: 8,
      relatedTrades: [
        ...losers
          .sort((a, b) => a.pnl - b.pnl)
          .slice(0, 3)
          .map((t) => t.id),
        ...winners
          .sort((a, b) => b.pnl - a.pnl)
          .slice(0, 3)
          .map((t) => t.id),
      ],
      category: "loss-aversion",
    };
  }

  return null;
}

/**
 * Detects tilt: after a >5% drawdown period, the next 5 trades have a win rate < 30%.
 */
export function detectTiltPattern(trades: Trade[]): AIInsight | null {
  if (trades.length < 6) return null;

  const sorted = [...trades].sort(compareByExitDate);

  // Calculate running equity curve to identify drawdown periods
  let peak = 0;
  let runningPnl = 0;

  for (let i = 0; i < sorted.length - 5; i++) {
    runningPnl += sorted[i]!.pnl;
    if (runningPnl > peak) {
      peak = runningPnl;
    }

    // Check for >5% drawdown from peak
    // Use peak as reference; if peak is 0 or negative, use absolute comparison
    const drawdown = peak > 0 ? (peak - runningPnl) / peak : 0;

    if (drawdown > 0.05) {
      // Check next 5 trades
      const next5 = sorted.slice(i + 1, i + 6);
      if (next5.length < 5) continue;

      const next5Wins = next5.filter((t) => t.pnl > 0).length;
      const next5WinRate = next5Wins / 5;

      if (next5WinRate < 0.3) {
        const drawdownPercent = Math.round(drawdown * 100);

        return {
          id: generateId(),
          type: "warning",
          title: "Tilt Pattern Detected",
          description:
            `After experiencing a ${drawdownPercent}% drawdown, your next 5 trades had a win rate of only ` +
            `${Math.round(next5WinRate * 100)}% (${next5Wins} out of 5 wins). This pattern suggests emotional ` +
            `decision-making following significant losses. When you are in a drawdown, your judgment is impaired ` +
            `by the desire to recover quickly. Consider implementing a mandatory cool-down period after drawdowns ` +
            `exceeding 5%, or switch to paper trading until you regain composure.`,
          severity: 9,
          relatedTrades: [sorted[i]!.id, ...next5.map((t) => t.id)],
          category: "tilt",
        };
      }
    }
  }

  return null;
}

/**
 * Detects the most consistently profitable trading pair (by win rate, minimum 5 trades).
 */
export function detectConsistentPair(trades: Trade[]): AIInsight | null {
  if (trades.length < 5) return null;

  const pairStats: Record<
    string,
    { total: number; wins: number; totalPnl: number; tradeIds: string[] }
  > = {};

  for (const trade of trades) {
    if (!pairStats[trade.pair]) {
      pairStats[trade.pair] = { total: 0, wins: 0, totalPnl: 0, tradeIds: [] };
    }
    pairStats[trade.pair]!.total++;
    if (trade.pnl > 0) pairStats[trade.pair]!.wins++;
    pairStats[trade.pair]!.totalPnl += trade.pnl;
    pairStats[trade.pair]!.tradeIds.push(trade.id);
  }

  let bestPair: string | null = null;
  let bestWinRate = 0;

  for (const pair of Object.keys(pairStats)) {
    const stats = pairStats[pair];
    if (stats!.total < 5) continue;
    // Phase 21 (AI Bug 6): a 'positive' pair must actually be profitable
    // and >50% WR. Without this we flagged unprofitable pairs as
    // 'Strong Performance' just because they were the LEAST bad.
    if (stats!.totalPnl <= 0) continue;
    const winRate = stats!.wins / stats!.total;
    if (winRate < 0.5) continue;
    if (winRate > bestWinRate) {
      bestWinRate = winRate;
      bestPair = pair;
    }
  }

  if (!bestPair) return null;

  const stats = pairStats[bestPair];
  const winRatePercent = Math.round(bestWinRate * 100);

  return {
    id: generateId(),
    type: "positive",
    title: "Strong Performance on a Consistent Pair",
    description:
      `${bestPair} is your best performing pair with a ${winRatePercent}% win rate across ${stats!.total} trades ` +
      `and a total P&L of $${stats!.totalPnl.toFixed(2)}. Your edge on this pair is clear and consistent. ` +
      `Consider allocating more of your trading capital and focus to ${bestPair}, as your strategy appears ` +
      `well-suited to its price action and liquidity profile.`,
    severity: 3,
    relatedTrades: stats!.tradeIds.slice(0, 10),
    category: "strength",
  };
}

/**
 * Detects good risk management: profit factor > 1.5 and max single loss < 3% of total equity.
 */
export function detectGoodRiskManagement(trades: Trade[]): AIInsight | null {
  if (trades.length < 5) return null;

  const grossProfit = trades
    .filter((t) => t.pnl > 0)
    .reduce((sum, t) => sum + t.pnl, 0);

  const grossLoss = Math.abs(
    trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0),
  );

  if (grossLoss === 0) {
    // No losses means infinite profit factor - still counts as good risk management
    return {
      id: generateId(),
      type: "positive",
      title: "Excellent Risk Management",
      description:
        `Across ${trades.length} trades, you have had zero losing trades with a total profit of $${grossProfit.toFixed(2)}. ` +
        `While this is exceptional, ensure you are not simply avoiding taking losses by holding underwater positions. ` +
        `Keep up the disciplined approach.`,
      severity: 2,
      relatedTrades: trades.slice(0, 10).map((t) => t.id),
      category: "risk-management",
    };
  }

  const profitFactor = grossProfit / grossLoss;

  // Phase 6 (AI Bug 3): "totalEquity = sum(|pnl|)" was semantically meaningless
  // — many small trades inflated the denominator → maxLossPercent always tiny
  // → false-positive "Strong Risk Management" insight. Use grossProfit (real
  // capital deployed) as a proxy that at least scales with the account.
  const totalEquity = grossProfit;
  const maxSingleLoss = Math.abs(
    Math.min(...trades.filter((t) => t.pnl < 0).map((t) => t.pnl)),
  );
  const maxLossPercent =
    totalEquity > 0 ? (maxSingleLoss / totalEquity) * 100 : 100;

  if (profitFactor > 1.5 && maxLossPercent < 3) {
    return {
      id: generateId(),
      type: "positive",
      title: "Strong Risk Management",
      description:
        `Your profit factor is ${profitFactor.toFixed(2)} (above the 1.5 threshold) and your largest single loss ` +
        `was only ${maxLossPercent.toFixed(1)}% of total traded equity. Across ${trades.length} trades, this shows ` +
        `disciplined position sizing and effective stop-loss usage. Your risk management is a key strength - ` +
        `maintain these habits as you scale your trading size.`,
      severity: 2,
      relatedTrades: trades.slice(0, 10).map((t) => t.id),
      category: "risk-management",
    };
  }

  return null;
}

/**
 * Detects overtrading: any day with >5 trades and <40% win rate on that day.
 */
export function detectOvertrading(trades: Trade[]): AIInsight | null {
  if (trades.length < 6) return null;

  const dayStats: Record<
    string,
    { total: number; wins: number; tradeIds: string[] }
  > = {};

  for (const trade of trades) {
    // Phase 52 (R45-CC-H4): bucket by ENTRY day — overtrading is a count
    // of trade-decisions per day, and decisions are made at entry, not
    // exit. Was using exitDate which lumped multi-day-hold exits into
    // the wrong bucket and disagreed with the dashboard heatmap.
    const day = new Date(trade.entryDate).toISOString().split("T")[0]!;
    if (!dayStats[day]) {
      dayStats[day] = { total: 0, wins: 0, tradeIds: [] };
    }
    dayStats[day]!.total++;
    if (trade.pnl > 0) dayStats[day]!.wins++;
    dayStats[day]!.tradeIds.push(trade.id);
  }

  for (const day of Object.keys(dayStats)) {
    const stats = dayStats[day]!;
    if (stats!.total > 5) {
      const winRate = stats!.wins / stats!.total;
      if (winRate < 0.4) {
        const winRatePercent = Math.round(winRate * 100);

        return {
          id: generateId(),
          type: "warning",
          title: "Overtrading Detected",
          description:
            `You placed ${stats!.total} trades on ${day} with only ${winRatePercent}% win rate. ` +
            `High-frequency trading often leads to poor decision making.`,
          severity: 7,
          relatedTrades: stats!.tradeIds.slice(0, 10),
          category: "overtrading",
        };
      }
    }
  }

  return null;
}

/**
 * Detects weekend trading: if >20% of trades are on Saturday/Sunday and weekend
 * win rate is >15 percentage points worse than weekday win rate.
 */
export function detectWeekendTrading(trades: Trade[]): AIInsight | null {
  if (trades.length < 5) return null;

  const weekdayTrades: Trade[] = [];
  const weekendTrades: Trade[] = [];

  for (const trade of trades) {
    // Phase 52 (R45-CC-H4): use entryDate — weekend-trading is a behavior
    // about WHEN you place trades, not when they happen to close.
    const dayOfWeek = getDayOfWeek(trade.entryDate);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      weekendTrades.push(trade);
    } else {
      weekdayTrades.push(trade);
    }
  }

  const weekendRatio = weekendTrades.length / trades.length;
  if (weekendRatio <= 0.2) return null;
  if (weekendTrades.length < 2 || weekdayTrades.length < 2) return null;

  const weekendWinRate =
    weekendTrades.filter((t) => t.pnl > 0).length / weekendTrades.length;
  const weekdayWinRate =
    weekdayTrades.filter((t) => t.pnl > 0).length / weekdayTrades.length;

  const difference = weekdayWinRate - weekendWinRate;

  if (difference > 0.15) {
    const weekendPercent = Math.round(weekendWinRate * 100);
    const weekdayPercent = Math.round(weekdayWinRate * 100);

    return {
      id: generateId(),
      type: "warning",
      title: "Weekend Trading Underperformance",
      description:
        `Your weekend win rate is ${weekendPercent}% compared to ${weekdayPercent}% on weekdays ` +
        `(a ${Math.round(difference * 100)} percentage point gap). ${weekendTrades.length} of your ` +
        `${trades.length} trades (${Math.round(weekendRatio * 100)}%) were placed on weekends. ` +
        `Consider reducing or eliminating weekend trading to improve overall performance.`,
      severity: 5,
      relatedTrades: weekendTrades.slice(0, 10).map((t) => t.id),
      category: "weekend-trading",
    };
  }

  return null;
}

/**
 * Detects improving performance: second chronological half has >10% better win rate than first half.
 */
export function detectImprovingPerformance(trades: Trade[]): AIInsight | null {
  // Phase 21 (AI Bug 7): minimum 20 trades (each half ≥10) so the win-rate
  // delta isn't dominated by 33%-step quantization noise. Was 6 → triggered
  // on virtually any 6-trade dataset by chance.
  if (trades.length < 20) return null;

  const sorted = [...trades].sort(compareByExitDate);

  const midpoint = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);

  const firstWinRate =
    firstHalf.filter((t) => t.pnl > 0).length / firstHalf.length;
  const secondWinRate =
    secondHalf.filter((t) => t.pnl > 0).length / secondHalf.length;

  const improvement = secondWinRate - firstWinRate;

  if (improvement > 0.1) {
    const firstPercent = Math.round(firstWinRate * 100);
    const secondPercent = Math.round(secondWinRate * 100);

    return {
      id: generateId(),
      type: "positive",
      title: "Performance Improving",
      description: `Your recent performance is improving! Win rate went from ${firstPercent}% to ${secondPercent}%.`,
      severity: 3,
      relatedTrades: secondHalf.slice(0, 10).map((t) => t.id),
      category: "improvement",
    };
  }

  return null;
}

/**
 * Detects declining performance: second chronological half has >10% worse win rate than first half.
 */
export function detectDecliningPerformance(trades: Trade[]): AIInsight | null {
  // Phase 21 (AI Bug 7): see detectImprovingPerformance — same 20-min threshold.
  if (trades.length < 20) return null;

  const sorted = [...trades].sort(compareByExitDate);

  const midpoint = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);

  const firstWinRate =
    firstHalf.filter((t) => t.pnl > 0).length / firstHalf.length;
  const secondWinRate =
    secondHalf.filter((t) => t.pnl > 0).length / secondHalf.length;

  const decline = firstWinRate - secondWinRate;

  if (decline > 0.1) {
    const firstPercent = Math.round(firstWinRate * 100);
    const secondPercent = Math.round(secondWinRate * 100);

    return {
      id: generateId(),
      type: "warning",
      title: "Performance Declining",
      description:
        `Your recent performance is declining. Win rate dropped from ${firstPercent}% to ${secondPercent}%. ` +
        `Consider taking a break.`,
      severity: 6,
      relatedTrades: secondHalf.slice(0, 10).map((t) => t.id),
      category: "declining",
    };
  }

  return null;
}

/**
 * Detects frequent pair switching: if the trading pair changes between >70% of consecutive trades.
 * Requires at least 10 trades.
 */
export function detectPairSwitching(trades: Trade[]): AIInsight | null {
  if (trades.length < 10) return null;

  const sorted = [...trades].sort(compareByExitDate);

  let switches = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.pair !== sorted[i - 1]!.pair) {
      switches++;
    }
  }

  const switchRate = switches / (sorted.length - 1);

  if (switchRate > 0.7) {
    const switchPercent = Math.round(switchRate * 100);

    return {
      id: generateId(),
      type: "warning",
      title: "Frequent Pair Switching",
      description:
        `You're frequently switching between pairs (${switchPercent}% of trades). ` +
        `Consider focusing on fewer markets to build expertise.`,
      severity: 5,
      relatedTrades: sorted.slice(0, 10).map((t) => t.id),
      category: "pair-switching",
    };
  }

  return null;
}

/**
 * Detects emotional-state performance gap: emotion-tagged trades (FOMO, revenge, greedy)
 * perform materially worse than neutral/confident trades.
 */
export function detectEmotionalPerformance(trades: Trade[]): AIInsight | null {
  const tagged = trades.filter((t) => t.emotion);
  if (tagged.length < 5) return null;

  const NEGATIVE: NonNullable<Trade["emotion"]>[] = [
    "fomo",
    "revenge",
    "greedy",
    "fearful",
  ];
  const POSITIVE: NonNullable<Trade["emotion"]>[] = ["confident", "neutral"];

  const negative = tagged.filter((t) => NEGATIVE.includes(t.emotion!));
  const positive = tagged.filter((t) => POSITIVE.includes(t.emotion!));

  if (negative.length < 3 || positive.length < 3) return null;

  const negWins = negative.filter((t) => t.pnl > 0).length;
  const posWins = positive.filter((t) => t.pnl > 0).length;
  const negWinRate = negWins / negative.length;
  const posWinRate = posWins / positive.length;
  const gap = posWinRate - negWinRate;

  if (gap >= 0.15) {
    const worstEmotion = NEGATIVE.reduce<{
      emotion: string;
      winRate: number;
      count: number;
    }>(
      (acc, emotion) => {
        const subset = negative.filter((t) => t.emotion === emotion);
        if (subset.length < 2) return acc;
        const winRate = subset.filter((t) => t.pnl > 0).length / subset.length;
        if (!acc.emotion || winRate < acc.winRate) {
          return { emotion, winRate, count: subset.length };
        }
        return acc;
      },
      { emotion: "", winRate: 1, count: 0 },
    );

    return {
      id: generateId(),
      type: "warning",
      title: "Emotional Trades Underperform",
      description:
        `Trades tagged as fomo/revenge/greedy/fearful win ${Math.round(negWinRate * 100)}% of the time, ` +
        `compared to ${Math.round(posWinRate * 100)}% for confident/neutral trades — a ${Math.round(gap * 100)}pp gap. ` +
        (worstEmotion.emotion
          ? `Your worst emotional state is "${worstEmotion.emotion}" (${Math.round(worstEmotion.winRate * 100)}% win rate across ${worstEmotion.count} trades). `
          : "") +
        `Consider a cool-off rule: no trades when flagging these emotions.`,
      severity: 7,
      relatedTrades: negative.slice(0, 10).map((t) => t.id),
      category: "emotional-discipline",
    };
  }

  return null;
}

/**
 * Detects best-performing setup type: highlights the setup with highest avg PnL
 * (needs at least 3 trades per setup and at least 2 distinct setups).
 */
export function detectBestSetup(trades: Trade[]): AIInsight | null {
  const withSetup = trades.filter((t) => t.setupType && t.setupType.trim());
  if (withSetup.length < 6) return null;

  const bySetup: Record<string, Trade[]> = {};
  for (const t of withSetup) {
    const key = t.setupType!.trim().toLowerCase();
    if (!bySetup[key]) bySetup[key] = [];
    bySetup[key].push(t);
  }

  const setups = Object.entries(bySetup).filter(([, arr]) => arr.length >= 3);
  if (setups.length < 2) return null;

  let best: {
    name: string;
    avgPnl: number;
    winRate: number;
    trades: Trade[];
  } | null = null;
  let overallAvg = 0;
  let totalCount = 0;

  for (const [name, arr] of setups) {
    const totalPnl = arr.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = totalPnl / arr.length;
    const wins = arr.filter((t) => t.pnl > 0).length;
    const winRate = wins / arr.length;
    overallAvg += totalPnl;
    totalCount += arr.length;
    if (!best || avgPnl > best.avgPnl) {
      best = { name, avgPnl, winRate, trades: arr };
    }
  }

  if (!best) return null;
  const meanAvg = overallAvg / totalCount;

  if (best.avgPnl <= 0 || best.avgPnl < meanAvg * 1.25) return null;

  return {
    id: generateId(),
    type: "positive",
    title: `Your Edge: "${best.name}" Setups`,
    description:
      `Your "${best.name}" setup averages ${best.avgPnl >= 0 ? "+" : ""}${best.avgPnl.toFixed(2)} PnL per trade ` +
      `with a ${Math.round(best.winRate * 100)}% win rate (${best.trades.length} trades). ` +
      `This is materially better than your other setups — consider allocating more capital to this playbook.`,
    severity: 3,
    relatedTrades: best.trades.slice(0, 10).map((t) => t.id),
    category: "setup-edge",
  };
}

/**
 * Detects fee drag: total fees eat into more than 20% of gross winning-side PnL.
 */
export function detectFeeDrag(trades: Trade[]): AIInsight | null {
  if (trades.length < 5) return null;

  // Phase 21 (AI Bug 8): normalize fee sign — some CSV importers store fees
  // as negative (cost convention), others positive. Maker rebates can mix.
  // Use absolute value so the detector works across conventions; mask
  // tiny rebates (|fee| < 1¢ per trade) as effectively zero.
  const totalFees = trades.reduce((s, t) => s + Math.abs(t.fees || 0), 0);
  if (totalFees <= 0) return null;

  const grossWins = trades
    .filter((t) => t.pnl > 0)
    .reduce((s, t) => s + t.pnl + Math.abs(t.fees || 0), 0);
  if (grossWins <= 0) return null;

  const ratio = totalFees / grossWins;
  if (ratio < 0.2) return null;

  return {
    id: generateId(),
    type: "warning",
    title: "Fees Are Eating Your Edge",
    description:
      `Total fees of ${totalFees.toFixed(2)} consumed ${Math.round(ratio * 100)}% of your gross winning PnL across ${trades.length} trades. ` +
      `High fee ratios often signal overtrading, low-edge scalps, or poor venue choice. ` +
      `Consider: fewer trades, larger per-trade edge, or a cheaper venue.`,
    severity: 6,
    relatedTrades: trades.slice(0, 10).map((t) => t.id),
    category: "fee-drag",
  };
}

/**
 * Detects day-of-week bias: flags the strongest and weakest weekday by avg PnL
 * when at least one weekday has 3+ trades and the spread is meaningful.
 */
export function detectDayOfWeekBias(trades: Trade[]): AIInsight | null {
  if (trades.length < 10) return null;

  const DAYS = DAYS_OF_WEEK;
  const byDay: Record<number, Trade[]> = {};
  for (const t of trades) {
    // Phase 52 (R45-CC-H4): bucket by entry day to match the dashboard
    // heatmap (calculations.calculatePerformanceByDayOfWeek already uses
    // entryDate). Was exitDate → "Sundays underperform" insight could
    // contradict the heatmap's Sunday cell for the same trade set.
    const d = getDayOfWeek(t.entryDate);
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(t);
  }

  const dayAvgs = Object.entries(byDay)
    .filter(([, arr]) => arr.length >= 3)
    .map(([d, arr]) => ({
      day: Number(d),
      avg: arr.reduce((s, t) => s + t.pnl, 0) / arr.length,
      trades: arr,
    }));

  if (dayAvgs.length < 2) return null;

  dayAvgs.sort((a, b) => b.avg - a.avg);
  const best = dayAvgs[0];
  const worst = dayAvgs[dayAvgs.length - 1];
  const spread = best!.avg - worst!.avg;

  // Require a non-trivial spread and one side clearly negative or best clearly positive
  if (spread < Math.max(Math.abs(best!.avg), Math.abs(worst!.avg)) * 0.5)
    return null;
  if (best!.avg <= 0 && worst!.avg >= 0) return null;

  const isWarning = worst!.avg < 0 && Math.abs(worst!.avg) > best!.avg;

  return {
    id: generateId(),
    type: isWarning ? "warning" : "positive",
    title: isWarning
      ? `${DAYS[worst!.day]}s Are Costing You`
      : `${DAYS[best!.day]}s Are Your Best Day`,
    description:
      `${DAYS[best!.day]}s average ${best!.avg >= 0 ? "+" : ""}${best!.avg.toFixed(2)} PnL across ${best!.trades.length} trades, ` +
      `while ${DAYS[worst!.day]}s average ${worst!.avg >= 0 ? "+" : ""}${worst!.avg.toFixed(2)} across ${worst!.trades.length}. ` +
      (isWarning
        ? `Consider skipping ${DAYS[worst!.day]}s or investigating why that day underperforms.`
        : `You might double down on ${DAYS[best!.day]}s and thin out activity on weaker days.`),
    severity: isWarning ? 6 : 3,
    relatedTrades: (isWarning ? worst!.trades : best!.trades)
      .slice(0, 10)
      .map((t) => t.id),
    category: "day-of-week-bias",
  };
}

/**
 * Runs all detection functions, filters out nulls, and returns insights sorted by severity (descending).
 */
export function generateAllInsights(trades: Trade[]): AIInsight[] {
  if (!trades || trades.length === 0) return [];

  const detectors = [
    detectRevengeTrade,
    detectHoldingLosers,
    detectTimePatterns,
    detectOverleverageAfterWins,
    detectLossAversion,
    detectTiltPattern,
    detectConsistentPair,
    detectGoodRiskManagement,
    detectOvertrading,
    detectWeekendTrading,
    detectImprovingPerformance,
    detectDecliningPerformance,
    detectPairSwitching,
    detectEmotionalPerformance,
    detectBestSetup,
    detectFeeDrag,
    detectDayOfWeekBias,
  ];

  const insights: AIInsight[] = [];

  for (const detector of detectors) {
    const result = detector(trades);
    if (result !== null) {
      insights.push(result);
    }
  }

  insights.sort((a, b) => b.severity - a.severity);

  return insights;
}
