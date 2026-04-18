import type { Candle } from "@/utils/indicators";
import { runAdvancedBacktest } from "@/utils/advancedBacktest";
import {
  DEFAULT_STRATEGY_CONFIG,
  type StrategyConfig,
} from "@/utils/strategies";

export interface OptimizerGrid {
  emaFast: number[];
  emaSlow: number[];
  adxTrendThreshold: number[];
  stopAtrMult: number[];
  targetAtrMult: number[];
}

export const DEFAULT_GRID: OptimizerGrid = {
  emaFast: [7, 9, 12],
  emaSlow: [21, 26, 34],
  adxTrendThreshold: [18, 22, 26],
  stopAtrMult: [1.5, 2, 2.5],
  targetAtrMult: [2, 3, 4],
};

export interface ParameterResult {
  config: StrategyConfig;
  is: {
    trades: number;
    totalReturnPct: number;
    sharpe: number;
    profitFactor: number;
    maxDrawdownPct: number;
  };
  oos: {
    trades: number;
    totalReturnPct: number;
    sharpe: number;
    profitFactor: number;
    maxDrawdownPct: number;
  };
  score: number; // combined IS+OOS fitness with overfit penalty
  stable: boolean;
}

export interface OptimizerOptions {
  candles: Candle[];
  timeframe: string;
  grid?: OptimizerGrid;
  trainRatio?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Grid-search optimisation with walk-forward: fits each candidate parameter
 * set on the training slice, then scores it on an unseen holdout. The final
 * score penalises parameter sets where IS vastly outperforms OOS (overfit).
 */
export async function optimizeParameters({
  candles,
  timeframe,
  grid = DEFAULT_GRID,
  trainRatio = 0.7,
  onProgress,
}: OptimizerOptions): Promise<ParameterResult[]> {
  const splitIdx = Math.floor(candles.length * trainRatio);
  const trainCandles = candles.slice(0, splitIdx);
  const testCandles = candles.slice(splitIdx);

  const combos: StrategyConfig[] = [];
  for (const emaFast of grid.emaFast) {
    for (const emaSlow of grid.emaSlow) {
      if (emaSlow <= emaFast) continue;
      for (const adxTrendThreshold of grid.adxTrendThreshold) {
        for (const stopAtrMult of grid.stopAtrMult) {
          for (const targetAtrMult of grid.targetAtrMult) {
            if (targetAtrMult <= stopAtrMult) continue;
            combos.push({
              ...DEFAULT_STRATEGY_CONFIG,
              emaFast,
              emaSlow,
              adxTrendThreshold,
              stopAtrMult,
              targetAtrMult,
            });
          }
        }
      }
    }
  }

  const results: ParameterResult[] = [];
  for (let idx = 0; idx < combos.length; idx++) {
    const config = combos[idx];
    const trainReport = runAdvancedBacktest({
      candles: trainCandles,
      timeframe,
      strategy: config,
    });
    const testReport = runAdvancedBacktest({
      candles: testCandles,
      timeframe,
      strategy: config,
    });

    const isPf =
      trainReport.metrics.profitFactor === Infinity
        ? 10
        : trainReport.metrics.profitFactor;
    const oosPf =
      testReport.metrics.profitFactor === Infinity
        ? 10
        : testReport.metrics.profitFactor;

    // Score: blend of OOS return and Sharpe, penalised if IS >> OOS (overfit)
    const overfitGap = isPf > 0 ? Math.max(0, (isPf - oosPf) / isPf) : 0;
    const score =
      testReport.metrics.totalReturnPct * 100 * 0.5 +
      testReport.metrics.sharpe * 20 * 0.3 +
      oosPf * 5 * 0.2 -
      overfitGap * 20;

    const stable =
      trainReport.metrics.trades >= 10 &&
      testReport.metrics.trades >= 5 &&
      overfitGap < 0.5;

    results.push({
      config,
      is: {
        trades: trainReport.metrics.trades,
        totalReturnPct: trainReport.metrics.totalReturnPct,
        sharpe: trainReport.metrics.sharpe,
        profitFactor: isPf,
        maxDrawdownPct: trainReport.metrics.maxDrawdownPct,
      },
      oos: {
        trades: testReport.metrics.trades,
        totalReturnPct: testReport.metrics.totalReturnPct,
        sharpe: testReport.metrics.sharpe,
        profitFactor: oosPf,
        maxDrawdownPct: testReport.metrics.maxDrawdownPct,
      },
      score,
      stable,
    });

    if (onProgress) onProgress(idx + 1, combos.length);
    // Yield to the browser so the UI stays responsive
    if (idx % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
