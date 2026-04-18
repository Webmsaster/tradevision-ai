/**
 * Regime-Adaptive Strategy Gate.
 *
 * Derived from the iter 10 per-strategy × regime PnL matrix: each strategy
 * has a whitelist of regimes in which it has historically positive mean
 * return. If current regime is NOT in a strategy's whitelist, suppress
 * its signals.
 *
 * This is the "edge rotation" the system needed: trade each edge only
 * when conditions have historically favoured it.
 */

import type { Regime } from "@/utils/regimeClassifier";

export interface StrategyRegimeWhitelist {
  strategy: string; // strategy name (matches ensembleEquity streams)
  whitelist: Regime[];
  why: string;
}

/**
 * Iter 10 empirical gating. Derived from live-data per-regime mean PnL:
 *   - Champion-SOL: universal (positive everywhere) → whitelist = all
 *   - Champion-ETH: kill trend-down (-0.07%)
 *   - Champion-BTC: ok everywhere (thin but positive)
 *   - Monday-ETH: kill trend-down (-0.71%)
 *   - Monday-SOL: kill everything except chop (only +0.21% there)
 *   - Monday-BTC: low sample, keep in chop only
 *   - FundingMinute-SOL: only leverage-bull, calm
 *   - FundingMinute-ETH: only leverage-bull
 *   - LeadLag-BTC→SOL: kill calm (too few signals), everything else ok
 *   - FundingCarry-*: always safe (market-neutral)
 */
export const DEFAULT_REGIME_WHITELIST: StrategyRegimeWhitelist[] = [
  {
    strategy: "Champion-SOLUSDT",
    whitelist: ["calm", "leverage-bull", "trend-up", "trend-down", "chop"],
    why: "Universal — positive mean PnL in every regime",
  },
  {
    strategy: "Champion-BTCUSDT",
    whitelist: ["calm", "trend-up", "trend-down", "chop"],
    why: "Thin but positive in all non-leverage regimes",
  },
  {
    strategy: "Champion-ETHUSDT",
    whitelist: ["calm", "trend-up", "chop"],
    why: "Negative in trend-down (-0.07%), skip that regime",
  },
  {
    strategy: "Monday-BTCUSDT",
    whitelist: ["chop"],
    why: "Low sample; only reliable in chop",
  },
  {
    strategy: "Monday-ETHUSDT",
    whitelist: ["calm", "trend-up", "chop"],
    why: "Very strong in chop (+1.15%), kills in trend-down (-0.71%)",
  },
  {
    strategy: "Monday-SOLUSDT",
    whitelist: ["chop"],
    why: "Only +0.21% in chop, negative elsewhere",
  },
  {
    strategy: "FundingMinute-SOLUSDT",
    whitelist: ["leverage-bull", "calm", "chop"],
    why: "+0.25% in leverage-bull, +0.42% in chop",
  },
  {
    strategy: "FundingMinute-ETHUSDT",
    whitelist: ["leverage-bull"],
    why: "+0.15% in leverage-bull only, negative elsewhere",
  },
  {
    strategy: "LeadLag-BTC→SOL",
    whitelist: ["leverage-bull", "trend-up", "trend-down", "chop"],
    why: "+0.60% in leverage-bull, strong in trends, skip calm",
  },
  {
    strategy: "FundingCarry-BTCUSDT",
    whitelist: [
      "calm",
      "leverage-bull",
      "leverage-bear",
      "trend-up",
      "trend-down",
      "chop",
    ],
    why: "Market-neutral — no regime harms it",
  },
  {
    strategy: "FundingCarry-ETHUSDT",
    whitelist: [
      "calm",
      "leverage-bull",
      "leverage-bear",
      "trend-up",
      "trend-down",
      "chop",
    ],
    why: "Market-neutral",
  },
  {
    strategy: "FundingCarry-SOLUSDT",
    whitelist: [
      "calm",
      "leverage-bull",
      "leverage-bear",
      "trend-up",
      "trend-down",
      "chop",
    ],
    why: "Market-neutral",
  },
];

export interface GateDecision {
  strategy: string;
  currentRegime: Regime;
  allowed: boolean;
  reason: string;
}

export function regimeGate(
  strategy: string,
  currentRegime: Regime,
  whitelist: StrategyRegimeWhitelist[] = DEFAULT_REGIME_WHITELIST,
): GateDecision {
  const entry = whitelist.find((w) => w.strategy === strategy);
  if (!entry) {
    // Unknown strategy — default allow but mark "no whitelist data"
    return {
      strategy,
      currentRegime,
      allowed: true,
      reason: "No whitelist entry — defaulting to allow",
    };
  }
  const allowed = entry.whitelist.includes(currentRegime);
  return {
    strategy,
    currentRegime,
    allowed,
    reason: allowed
      ? `${currentRegime} in whitelist: ${entry.why}`
      : `${currentRegime} NOT in whitelist (${entry.whitelist.join(",")}): ${entry.why}`,
  };
}

/**
 * Filter a list of trades so only those whose bar-regime is whitelisted for
 * the strategy are kept. Use this to measure "what if we had run regime-
 * adaptive gating historically."
 */
export function filterTradesByRegime(
  trades: { time: number; pnlPct: number; strategy: string }[],
  regimeAt: (time: number) => Regime | null,
  whitelist: StrategyRegimeWhitelist[] = DEFAULT_REGIME_WHITELIST,
): { kept: typeof trades; dropped: typeof trades } {
  const kept: typeof trades = [];
  const dropped: typeof trades = [];
  for (const t of trades) {
    const r = regimeAt(t.time);
    if (!r) {
      kept.push(t);
      continue;
    }
    const g = regimeGate(t.strategy, r, whitelist);
    if (g.allowed) kept.push(t);
    else dropped.push(t);
  }
  return { kept, dropped };
}
