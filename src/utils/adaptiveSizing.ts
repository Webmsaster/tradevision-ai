/**
 * Adaptive Kelly sizing — uses LIVE-measured edge stats instead of frozen
 * backtest stats whenever we have enough samples.
 *
 * Rationale: STRATEGY_EDGE_STATS are baked from backtest numbers. If the
 * market regime changes and the edge degrades (or improves), Kelly sizing
 * on the stale backtest numbers will overbet (or underbet). Adaptive
 * sizing recomputes {WR, avgWin, avgLoss} from the most recent N closed
 * trades and blends with backtest when n is still small.
 *
 * Blend rule (Bayesian shrinkage):
 *   If n < minN (default 30): use backtest stats (not enough live data)
 *   If n >= minN: use pure live stats
 *   (No fancy shrinkage — Kelly is robust to modest stat noise at n>=30)
 *
 * Intentionally conservative: live stats on tiny samples can be
 * catastrophically wrong. minN=30 = enough to detect true regime shift.
 */
import type { EdgeStats } from "@/utils/positionSizing";
import { STRATEGY_EDGE_STATS } from "@/utils/positionSizing";

export interface AdaptiveResult {
  strategy: string;
  /** Number of recent closed trades used (0 means fallback). */
  liveN: number;
  /** Whether we used live stats (true) or backtest fallback (false). */
  usedLive: boolean;
  stats: EdgeStats;
  /** Backtest stats for reference. */
  backtest: EdgeStats;
}

export interface AdaptiveSizingOptions {
  /** Minimum live sample count before switching to live stats. */
  minLiveN?: number;
  /** Only count trades newer than this many days (default 60). */
  lookbackDays?: number;
}

export function computeLiveEdgeStats(
  closedTrades: Array<{
    strategy: string;
    netPnlPct: number;
    exitTime: string;
  }>,
  strategy: string,
  opts: AdaptiveSizingOptions = {},
): AdaptiveResult {
  const minN = opts.minLiveN ?? 30;
  const lookbackDays = opts.lookbackDays ?? 60;
  const cutoff = Date.now() - lookbackDays * 86400_000;
  const recent = closedTrades.filter(
    (t) => t.strategy === strategy && new Date(t.exitTime).getTime() >= cutoff,
  );
  const backtest: EdgeStats = STRATEGY_EDGE_STATS[strategy] ?? {
    winRate: 0.5,
    avgWinPct: 0.01,
    avgLossPct: 0.01,
  };
  if (recent.length < minN) {
    return {
      strategy,
      liveN: recent.length,
      usedLive: false,
      stats: backtest,
      backtest,
    };
  }
  const wins = recent.filter((t) => t.netPnlPct > 0);
  const losses = recent.filter((t) => t.netPnlPct <= 0);
  const winRate = wins.length / recent.length;
  const avgWinPct =
    wins.length > 0
      ? wins.reduce((s, t) => s + t.netPnlPct, 0) / wins.length
      : backtest.avgWinPct;
  const avgLossPct =
    losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + t.netPnlPct, 0) / losses.length)
      : backtest.avgLossPct;
  return {
    strategy,
    liveN: recent.length,
    usedLive: true,
    stats: { winRate, avgWinPct, avgLossPct },
    backtest,
  };
}

/** Compute adaptive stats for all known strategies in STRATEGY_EDGE_STATS. */
export function adaptiveStrategyStatsMap(
  closedTrades: Array<{
    strategy: string;
    netPnlPct: number;
    exitTime: string;
  }>,
  opts?: AdaptiveSizingOptions,
): Record<string, AdaptiveResult> {
  const out: Record<string, AdaptiveResult> = {};
  for (const key of Object.keys(STRATEGY_EDGE_STATS)) {
    out[key] = computeLiveEdgeStats(closedTrades, key, opts);
  }
  return out;
}
