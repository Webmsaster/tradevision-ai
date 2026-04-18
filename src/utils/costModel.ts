/**
 * Cost model for realistic backtests. All values are in fractional units
 * (0.0004 = 0.04%). Defaults reflect Binance Futures USDT-M taker rates.
 */
export interface CostConfig {
  takerFee: number; // paid on entry + exit
  slippageBps: number; // basis points (1 bp = 0.01%) applied to price
  fundingBpPerHour: number; // approx average funding cost per hour in bps (bps = 0.01%)
}

export const DEFAULT_COSTS: CostConfig = {
  takerFee: 0.0004, // 0.04% taker
  slippageBps: 2, // 2bp per side
  fundingBpPerHour: 0.1, // ~0.01% per 8h funding (Binance avg), spread across hours
};

export interface CostAdjustInput {
  entry: number;
  exit: number;
  direction: "long" | "short";
  holdingHours: number;
  config?: CostConfig;
}

export interface CostAdjustOutput {
  grossPnlPct: number;
  feesPct: number;
  slippagePct: number;
  fundingPct: number;
  netPnlPct: number;
}

/**
 * Adjusts a trade's gross PnL for fees, slippage, and funding. Returns all
 * cost components separately so they can be displayed in the UI.
 */
export function applyCosts(input: CostAdjustInput): CostAdjustOutput {
  const cfg = input.config ?? DEFAULT_COSTS;
  const grossPct =
    input.direction === "long"
      ? (input.exit - input.entry) / input.entry
      : (input.entry - input.exit) / input.entry;

  // Fees apply on both legs, as a percentage of notional
  const feesPct = cfg.takerFee * 2;
  // Slippage costs you bps on each side (enter worse, exit worse)
  const slippagePct = (cfg.slippageBps / 10_000) * 2;
  // Funding applies only to the holding duration (one side of market)
  const fundingPct =
    (cfg.fundingBpPerHour / 10_000) * Math.max(0, input.holdingHours);

  const netPnlPct = grossPct - feesPct - slippagePct - fundingPct;

  return { grossPnlPct: grossPct, feesPct, slippagePct, fundingPct, netPnlPct };
}

/**
 * Converts a percentage PnL to an R-multiple given the risk-per-trade (stop
 * distance in price units as a fraction of entry).
 */
export function pnlPctToR(pnlPct: number, stopDistancePct: number): number {
  if (stopDistancePct <= 0) return 0;
  return pnlPct / stopDistancePct;
}
