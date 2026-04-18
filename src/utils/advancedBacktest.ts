import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import {
  regimeSwitch,
  DEFAULT_STRATEGY_CONFIG,
  type StrategyConfig,
  type StrategyName,
} from "@/utils/strategies";
import {
  computeMetrics,
  type PerformanceMetrics,
} from "@/utils/performanceMetrics";

export interface RealTrade {
  openTime: number;
  closeTime: number;
  direction: "long" | "short";
  strategy: StrategyName;
  entry: number;
  exit: number;
  holdingHours: number;
  grossPnlPct: number;
  netPnlPct: number;
  feesPct: number;
  slippagePct: number;
  fundingPct: number;
  exitReason: "tp" | "sl" | "flip" | "end";
}

export interface BacktestReport {
  metrics: PerformanceMetrics;
  trades: RealTrade[];
  periodStart: number;
  periodEnd: number;
  candleCount: number;
  profitableAfterCosts: boolean;
}

const TF_HOURS_MAP: Record<string, number> = {
  "1m": 1 / 60,
  "5m": 5 / 60,
  "15m": 15 / 60,
  "1h": 1,
};

export interface RunOptions {
  candles: Candle[];
  timeframe: string;
  strategy?: StrategyConfig;
  costs?: CostConfig;
  minBarsBeforeTrade?: number;
}

/**
 * Walks through the candle history, decides on each bar via regime-switcher,
 * opens/closes positions via SL/TP triggers, applies fees+slippage+funding to
 * every trade, and returns a report with an industry-standard metrics panel.
 */
export function runAdvancedBacktest({
  candles,
  timeframe,
  strategy = DEFAULT_STRATEGY_CONFIG,
  costs = DEFAULT_COSTS,
  minBarsBeforeTrade = 50,
}: RunOptions): BacktestReport {
  const trades: RealTrade[] = [];
  const hoursPerBar = TF_HOURS_MAP[timeframe] ?? 1;

  let open: {
    direction: "long" | "short";
    strategy: StrategyName;
    entry: number;
    stop: number;
    target: number;
    openTime: number;
    openIndex: number;
  } | null = null;

  for (let i = minBarsBeforeTrade; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const current = candles[i];

    if (open) {
      // Check for SL / TP hit within this candle
      let exited: "tp" | "sl" | null = null;
      if (open.direction === "long") {
        if (current.low <= open.stop) exited = "sl";
        else if (current.high >= open.target) exited = "tp";
      } else {
        if (current.high >= open.stop) exited = "sl";
        else if (current.low <= open.target) exited = "tp";
      }

      if (exited) {
        const exitPrice = exited === "sl" ? open.stop : open.target;
        const holdingHours = (i - open.openIndex) * hoursPerBar;
        const cost = applyCosts({
          entry: open.entry,
          exit: exitPrice,
          direction: open.direction,
          holdingHours,
          config: costs,
        });
        trades.push({
          openTime: open.openTime,
          closeTime: current.closeTime,
          direction: open.direction,
          strategy: open.strategy,
          entry: open.entry,
          exit: exitPrice,
          holdingHours,
          ...cost,
          exitReason: exited,
        });
        open = null;
      }
    }

    if (!open) {
      const { decision } = regimeSwitch(window, strategy);
      if (
        decision.action !== "flat" &&
        decision.stopDistance !== null &&
        decision.targetDistance !== null
      ) {
        const entry = current.close;
        const stop =
          decision.action === "long"
            ? entry - decision.stopDistance
            : entry + decision.stopDistance;
        const target =
          decision.action === "long"
            ? entry + decision.targetDistance
            : entry - decision.targetDistance;
        open = {
          direction: decision.action,
          strategy: decision.strategy,
          entry,
          stop,
          target,
          openTime: current.closeTime,
          openIndex: i,
        };
      }
    }
  }

  // Close any still-open position at the last candle
  if (open) {
    const last = candles[candles.length - 1];
    const holdingHours = (candles.length - 1 - open.openIndex) * hoursPerBar;
    const cost = applyCosts({
      entry: open.entry,
      exit: last.close,
      direction: open.direction,
      holdingHours,
      config: costs,
    });
    trades.push({
      openTime: open.openTime,
      closeTime: last.closeTime,
      direction: open.direction,
      strategy: open.strategy,
      entry: open.entry,
      exit: last.close,
      holdingHours,
      ...cost,
      exitReason: "end",
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const metrics = computeMetrics({
    returnsPct: returns,
    periodsPerYear: 365,
    riskPerTradePct: 0.01,
  });

  return {
    metrics,
    trades,
    periodStart: candles[0]?.openTime ?? 0,
    periodEnd: candles[candles.length - 1]?.closeTime ?? 0,
    candleCount: candles.length,
    profitableAfterCosts:
      metrics.totalReturnPct > 0 &&
      metrics.profitFactor > 1 &&
      metrics.sharpe > 0.5,
  };
}
