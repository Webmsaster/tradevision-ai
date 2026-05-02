/**
 * Position Sizing — turns a bootstrap-validated edge into a risk-calibrated
 * $ position size. Three methods supported:
 *
 *   1. Kelly-Criterion f* = (WR × W - (1-WR) × L) / W
 *      where W = avgWin (fractional), L = avgLoss (positive fraction).
 *      Returns the optimal-growth fraction of capital to bet.
 *
 *   2. Fraction-Kelly (recommended for real money) — 0.25 × f*.
 *      Full Kelly is mathematically optimal for long-run growth but has
 *      catastrophic drawdown risk under bad regimes. Quarter-Kelly
 *      (Shannon/Thorp standard) gives 88% of growth at 1/4 the drawdown.
 *
 *   3. Fixed-Risk Position Sizing — position such that hitting the
 *      stop loses a fixed % of capital (e.g. 1%). Independent of edge
 *      statistics; only needs stop-distance.
 *
 * All helpers return a NOTIONAL dollar amount you should open; convert to
 * a unit count by `notional / entryPrice`.
 */

export interface SizingInput {
  capital: number; // total account equity in $
  entry: number; // entry price
  stop: number; // stop-loss price
}

export interface EdgeStats {
  /** Win rate as 0..1 fraction. */
  winRate: number;
  /** Average WINNING trade PnL as positive fraction (e.g. 0.008 for +0.8%). */
  avgWinPct: number;
  /** Average LOSING trade PnL as positive fraction (e.g. 0.02 for -2%). */
  avgLossPct: number;
}

/**
 * Full Kelly fraction (0..1). Capped at 0.5 — values above that indicate
 * an unrealistic edge (and are pathological to deploy).
 */
export function kellyFraction(stats: EdgeStats): number {
  const { winRate: w, avgWinPct: W, avgLossPct: L } = stats;
  if (W <= 0 || L <= 0) return 0;
  // f* = (p×b - q) / b  where b = W/L (odds), p = w, q = 1-w
  const b = W / L;
  const p = w;
  const q = 1 - w;
  const f = (p * b - q) / b;
  if (!isFinite(f) || f <= 0) return 0;
  return Math.min(f, 0.5);
}

/**
 * Quarter-Kelly (0.25 × f*). Recommended for real-money live trading —
 * balances growth with survivability under regime changes / bad runs.
 */
export function quarterKelly(stats: EdgeStats): number {
  return kellyFraction(stats) * 0.25;
}

/**
 * Fixed-Risk sizing: notional = capital × riskPct / (|entry - stop| / entry).
 * Example: $10k capital, 1% risk, entry 100, stop 97 → risk-distance 3%,
 * position = 10000 × 0.01 / 0.03 = $3,333 notional.
 */
export function fixedRiskNotional(
  input: SizingInput & { riskPct: number },
): number {
  if (input.entry <= 0 || input.stop <= 0) return 0;
  const stopDist = Math.abs(input.entry - input.stop) / input.entry;
  if (stopDist <= 0) return 0;
  return (input.capital * input.riskPct) / stopDist;
}

/**
 * Kelly sizing in NOTIONAL dollars. Uses edge stats + stop-distance to
 * convert the optimal fraction into a position size.
 *
 * capital × f_kelly = $ at risk from full drawdown, but the actual risk
 * per trade is stop-distance × notional. So:
 *   notional = capital × f_kelly / stop_distance
 */
export function kellyNotional(
  stats: EdgeStats,
  input: SizingInput,
  fraction: "full" | "quarter" = "quarter",
): number {
  const f = fraction === "full" ? kellyFraction(stats) : quarterKelly(stats);
  if (f <= 0) return 0;
  const stopDist = Math.abs(input.entry - input.stop) / input.entry;
  if (stopDist <= 0) return 0;
  return (input.capital * f) / stopDist;
}

export type SizingMethod = "fixed-risk" | "quarter-kelly" | "full-kelly";

export interface SizingRecommendation {
  method: SizingMethod;
  /** Suggested notional position size in $. */
  notional: number;
  /** Units to buy (notional / entry). */
  units: number;
  /** Max loss in $ if stop hits. */
  maxLoss: number;
  /** Max loss as % of capital. */
  maxLossPct: number;
  /** Kelly fraction used (undefined for fixed-risk). */
  kellyFraction?: number;
  /** Caps or warnings applied. */
  notes: string[];
}

export interface RecommendOptions {
  capital: number;
  entry: number;
  stop: number;
  /** Required for kelly methods. */
  stats?: EdgeStats;
  /** Required for fixed-risk (default 0.01 = 1%). */
  riskPct?: number;
  method: SizingMethod;
  /** Hard cap on notional as % of capital (default 0.25 = 25% per position). */
  maxNotionalPctOfCapital?: number;
}

export function recommendSize(opts: RecommendOptions): SizingRecommendation {
  const notes: string[] = [];
  const maxNotionalCap = opts.maxNotionalPctOfCapital ?? 0.25;
  let notional: number;
  let kellyFrac: number | undefined;

  if (opts.method === "fixed-risk") {
    notional = fixedRiskNotional({
      capital: opts.capital,
      entry: opts.entry,
      stop: opts.stop,
      riskPct: opts.riskPct ?? 0.01,
    });
  } else {
    if (!opts.stats) {
      notes.push("method requires stats — defaulting notional 0");
      return {
        method: opts.method,
        notional: 0,
        units: 0,
        maxLoss: 0,
        maxLossPct: 0,
        notes,
      };
    }
    kellyFrac =
      opts.method === "full-kelly"
        ? kellyFraction(opts.stats)
        : quarterKelly(opts.stats);
    notional = kellyNotional(
      opts.stats,
      { capital: opts.capital, entry: opts.entry, stop: opts.stop },
      opts.method === "full-kelly" ? "full" : "quarter",
    );
  }

  // Hard cap at maxNotionalPctOfCapital
  const capDollar = opts.capital * maxNotionalCap;
  if (notional > capDollar) {
    notes.push(
      `capped at ${(maxNotionalCap * 100).toFixed(0)}% of capital (was ${((notional / opts.capital) * 100).toFixed(1)}%)`,
    );
    notional = capDollar;
  }

  const stopDist = Math.abs(opts.entry - opts.stop) / opts.entry;
  const maxLoss = notional * stopDist;
  const maxLossPct = opts.capital > 0 ? maxLoss / opts.capital : 0;

  return {
    method: opts.method,
    notional,
    units: opts.entry > 0 ? notional / opts.entry : 0,
    maxLoss,
    maxLossPct,
    kellyFraction: kellyFrac,
    notes,
  };
}

/**
 * Per-strategy edge stats baked from each strategy's bootstrap (iter34 /
 * iter53 / iter57). These are CONSERVATIVE estimates — use avgLoss from
 * bootstrap-min, avgWin from bootstrap-median, WR from bootstrap-min.
 */
export const STRATEGY_EDGE_STATS: Record<string, EdgeStats> = {
  "hf-daytrading": {
    winRate: 0.85, // iter57 min across 15 windows
    avgWinPct: 0.006, // ~0.6% typical scale-out tp1/tp2 blend
    avgLossPct: 0.03, // 3% wide stop (worst case)
  },
  "hi-wr-1h": {
    winRate: 0.718, // iter53 min
    avgWinPct: 0.006,
    avgLossPct: 0.0264, // stopPct 0.012 × 2.2 stop multiplier
  },
  "vol-spike-1h": {
    winRate: 0.5, // iter34 typical
    avgWinPct: 0.015, // wider targets in vol-spike single-leg
    avgLossPct: 0.012, // 1.2% stop
  },
};
