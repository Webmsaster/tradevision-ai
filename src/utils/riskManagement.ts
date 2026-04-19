/**
 * Risk Management — gatekeeper for new positions.
 *
 * Before opening any new paper/live trade, check against the active risk
 * state. Reject or warn if any of these guards fire:
 *
 *   1. Daily loss cap  — if closed trades today have already lost ≥ X% of
 *      capital, no more trades until tomorrow (UTC boundary).
 *   2. Max concurrent positions — limit on total open positions.
 *   3. Max same-direction — no more than N same-direction positions open
 *      at once (avoid correlated macro exposure).
 *   4. Max per-symbol — only one open position per symbol at a time.
 *   5. Max total exposure — sum of all open-position notionals ≤ X × capital.
 */
import type { ClosedTrade, PaperPosition } from "@/utils/paperTradeLogger";

export interface RiskLimits {
  /** Daily loss stop — if cumulative realised PnL today is ≤ -X, halt. */
  dailyLossPct: number;
  /** Max open positions across all strategies. */
  maxConcurrent: number;
  /** Max same-direction open positions (long+long+long macro risk). */
  maxSameDirection: number;
  /** Max total open-notional as multiple of capital (leverage cap). */
  maxTotalExposureMult: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  dailyLossPct: 0.03, // stop trading for the day after -3% realised loss
  maxConcurrent: 5,
  maxSameDirection: 3,
  maxTotalExposureMult: 1.0, // no more than 1× capital in open positions (no leverage)
};

export interface RiskState {
  capital: number;
  dailyRealisedPct: number;
  openCount: number;
  openLongCount: number;
  openShortCount: number;
  totalOpenNotional: number;
  totalExposureMult: number;
  bySymbol: Record<string, number>; // count per symbol
}

/**
 * Compute current risk state from capital, closed-today trades, and open
 * positions (with optional live notional for each open).
 */
export function computeRiskState(args: {
  capital: number;
  closedTrades: ClosedTrade[];
  openPositions: PaperPosition[];
  now?: Date;
  /** If not provided, each open position's notional defaults to 0. */
  openNotionals?: Record<string, number>;
}): RiskState {
  const now = args.now ?? new Date();
  const todayUtc = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const todaysTrades = args.closedTrades.filter((t) =>
    t.exitTime.startsWith(todayUtc),
  );
  // Realised daily = sum of netPnl (compound effect small for per-day scope)
  const dailyRealisedPct = todaysTrades.reduce((s, t) => s + t.netPnlPct, 0);
  const openLongCount = args.openPositions.filter(
    (p) => p.direction === "long",
  ).length;
  const openShortCount = args.openPositions.filter(
    (p) => p.direction === "short",
  ).length;
  const bySymbol: Record<string, number> = {};
  for (const p of args.openPositions) {
    bySymbol[p.symbol] = (bySymbol[p.symbol] ?? 0) + 1;
  }
  const totalOpenNotional = args.openPositions.reduce(
    (s, p) => s + (args.openNotionals?.[p.id] ?? 0),
    0,
  );
  return {
    capital: args.capital,
    dailyRealisedPct,
    openCount: args.openPositions.length,
    openLongCount,
    openShortCount,
    totalOpenNotional,
    totalExposureMult: args.capital > 0 ? totalOpenNotional / args.capital : 0,
    bySymbol,
  };
}

export interface RiskDecision {
  allowed: boolean;
  /** If allowed=false, one of these reasons. Empty if allowed. */
  reasons: string[];
  /** Informational warnings even if allowed. */
  warnings: string[];
}

export function evaluateEntry(args: {
  state: RiskState;
  direction: "long" | "short";
  symbol: string;
  notional: number;
  limits?: RiskLimits;
}): RiskDecision {
  const limits = args.limits ?? DEFAULT_RISK_LIMITS;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (args.state.dailyRealisedPct <= -limits.dailyLossPct) {
    reasons.push(
      `daily loss cap: ${(args.state.dailyRealisedPct * 100).toFixed(2)}% ≤ -${(limits.dailyLossPct * 100).toFixed(1)}% — halted until tomorrow UTC`,
    );
  }
  if (args.state.openCount >= limits.maxConcurrent) {
    reasons.push(
      `max concurrent: ${args.state.openCount} open ≥ ${limits.maxConcurrent}`,
    );
  }
  const sameDirCount =
    args.direction === "long"
      ? args.state.openLongCount
      : args.state.openShortCount;
  if (sameDirCount >= limits.maxSameDirection) {
    reasons.push(
      `max same-direction: ${sameDirCount} ${args.direction}s already open ≥ ${limits.maxSameDirection}`,
    );
  }
  if ((args.state.bySymbol[args.symbol] ?? 0) > 0) {
    reasons.push(
      `duplicate symbol: ${args.symbol} already has an open position`,
    );
  }
  const nextExposureMult =
    args.state.capital > 0
      ? (args.state.totalOpenNotional + args.notional) / args.state.capital
      : Infinity;
  if (nextExposureMult > limits.maxTotalExposureMult) {
    reasons.push(
      `max exposure: next ${nextExposureMult.toFixed(2)}× > ${limits.maxTotalExposureMult}×`,
    );
  }

  // Warnings (allowed but worth flagging)
  if (args.state.dailyRealisedPct <= -limits.dailyLossPct * 0.7) {
    warnings.push(
      `daily PnL ${(args.state.dailyRealisedPct * 100).toFixed(2)}% — approaching daily loss cap`,
    );
  }
  if (args.state.openCount === limits.maxConcurrent - 1) {
    warnings.push(
      `one more position will hit max concurrent (${limits.maxConcurrent})`,
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    warnings,
  };
}
