import type { Candle } from "@/utils/indicators";
import { applyCosts, DEFAULT_COSTS, type CostConfig } from "@/utils/costModel";
import { loadBinanceHistory } from "@/utils/historicalData";
import {
  computeMetrics,
  type PerformanceMetrics,
} from "@/utils/performanceMetrics";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

// ---------------------------------------------------------------------------
// Cross-Sectional Momentum Rotation — rotate capital weekly into the asset
// with the strongest N-week rate-of-change. Research basis:
//
//   Liu & Tsyvinski (2021) "Risks and Returns of Cryptocurrency", RFS:
//     cross-sectional momentum generates Sharpe 1.0-1.4 on crypto panels
//   Grobys & Sapkota (2019) "Cryptocurrencies and momentum" (EL):
//     time-series and cross-sectional momentum both persist
//   Bianchi, Guidolin, Pedio (2023) "Factor Models for Crypto Returns":
//     momentum is the single strongest factor across crypto majors
//
// Why it works: investor-attention rotation + limits-to-arbitrage + positive
// autocorrelation in attention-driven flows. Fresh capital chases recent
// winners for 4-12 weeks before exhausting.
// ---------------------------------------------------------------------------

export interface CrossSectionalConfig {
  lookbackBars: number; // ROC lookback, e.g. 4 bars on 1w = 28 days
  topN: number; // hold top N assets, equal-weight
  skipLastBars: number; // momentum-reversal skip (e.g. 1 week)
  rebalanceEveryBar: boolean; // rebalance on every bar of target TF
}

export const DEFAULT_CROSS_SECTIONAL_CONFIG: CrossSectionalConfig = {
  lookbackBars: 4,
  topN: 1,
  skipLastBars: 0,
  rebalanceEveryBar: true,
};

export interface RotationTrade {
  openTime: number;
  closeTime: number;
  symbol: string;
  direction: "long";
  entry: number;
  exit: number;
  holdingHours: number;
  grossPnlPct: number;
  netPnlPct: number;
  feesPct: number;
  slippagePct: number;
  fundingPct: number;
}

export interface RotationReport {
  metrics: PerformanceMetrics;
  trades: RotationTrade[];
  heldByBar: (string | null)[];
  rankings: { bar: number; ranked: { symbol: string; roc: number }[] }[];
}

const TF_HOURS: Record<string, number> = {
  "1h": 1,
  "4h": 4,
  "1d": 24,
  "1w": 168,
};

export interface CrossSectionalInput {
  byCandles: Record<string, Candle[]>; // pre-aligned candle series per symbol
  timeframe: LiveTimeframe;
  costs?: CostConfig;
  config?: CrossSectionalConfig;
}

function alignSeries(byCandles: Record<string, Candle[]>): {
  symbols: string[];
  matrix: number[][]; // [bar][symbol] = close
  times: number[];
} {
  const symbols = Object.keys(byCandles);
  if (symbols.length === 0) return { symbols, matrix: [], times: [] };
  // Intersect openTime keys
  const sets = symbols.map((s) => new Set(byCandles[s].map((c) => c.openTime)));
  const sharedTimes = [...sets[0]]
    .filter((t) => sets.every((s) => s.has(t)))
    .sort((a, b) => a - b);
  const matrix: number[][] = [];
  for (const t of sharedTimes) {
    const row: number[] = [];
    for (const s of symbols) {
      const c = byCandles[s].find((c) => c.openTime === t);
      row.push(c!.close);
    }
    matrix.push(row);
  }
  return { symbols, matrix, times: sharedTimes };
}

export function runCrossSectionalRotation({
  byCandles,
  timeframe,
  costs = DEFAULT_COSTS,
  config = DEFAULT_CROSS_SECTIONAL_CONFIG,
}: CrossSectionalInput): RotationReport {
  const { symbols, matrix, times } = alignSeries(byCandles);
  const hoursPerBar = TF_HOURS[timeframe] ?? 24;
  const trades: RotationTrade[] = [];
  const heldByBar: (string | null)[] = [];
  const rankings: RotationReport["rankings"] = [];

  if (matrix.length < config.lookbackBars + config.skipLastBars + 5) {
    return {
      metrics: computeMetrics({ returnsPct: [], periodsPerYear: 52 }),
      trades,
      heldByBar,
      rankings,
    };
  }

  let currentHold: {
    symbol: string;
    symbolIdx: number;
    entry: number;
    openTime: number;
    openBar: number;
  } | null = null;

  for (
    let i = config.lookbackBars + config.skipLastBars;
    i < matrix.length;
    i++
  ) {
    // Compute ROC for each symbol: (close[i-skip] / close[i-skip-lookback]) - 1
    const refIdx = i - config.skipLastBars;
    const baseIdx = refIdx - config.lookbackBars;
    const rocs = symbols.map((s, sIdx) => {
      const ref = matrix[refIdx][sIdx];
      const base = matrix[baseIdx][sIdx];
      return { symbol: s, idx: sIdx, roc: base > 0 ? ref / base - 1 : 0 };
    });
    rocs.sort((a, b) => b.roc - a.roc);
    rankings.push({
      bar: i,
      ranked: rocs.map((r) => ({ symbol: r.symbol, roc: r.roc })),
    });

    // Only hold if top asset has positive momentum (absolute filter)
    const topAsset = rocs[0];
    const shouldHold = topAsset.roc > 0 ? topAsset : null;

    // If not rebalancing every bar, only switch on week boundary (already
    // implicit if candles are weekly)
    const needToSwitch =
      !currentHold ||
      shouldHold === null ||
      currentHold.symbol !== shouldHold.symbol;

    if (currentHold && needToSwitch) {
      // Close current hold
      const exitPrice = matrix[i][currentHold.symbolIdx];
      const holdingHours = (i - currentHold.openBar) * hoursPerBar;
      const cost = applyCosts({
        entry: currentHold.entry,
        exit: exitPrice,
        direction: "long",
        holdingHours,
        config: costs,
      });
      trades.push({
        openTime: currentHold.openTime,
        closeTime: times[i],
        symbol: currentHold.symbol,
        direction: "long",
        entry: currentHold.entry,
        exit: exitPrice,
        holdingHours,
        ...cost,
      });
      currentHold = null;
    }

    if (!currentHold && shouldHold) {
      const entry = matrix[i][shouldHold.idx];
      currentHold = {
        symbol: shouldHold.symbol,
        symbolIdx: shouldHold.idx,
        entry,
        openTime: times[i],
        openBar: i,
      };
    }

    heldByBar.push(currentHold?.symbol ?? null);
  }

  if (currentHold) {
    const lastBar = matrix.length - 1;
    const exitPrice = matrix[lastBar][currentHold.symbolIdx];
    const holdingHours = (lastBar - currentHold.openBar) * hoursPerBar;
    const cost = applyCosts({
      entry: currentHold.entry,
      exit: exitPrice,
      direction: "long",
      holdingHours,
      config: costs,
    });
    trades.push({
      openTime: currentHold.openTime,
      closeTime: times[lastBar],
      symbol: currentHold.symbol,
      direction: "long",
      entry: currentHold.entry,
      exit: exitPrice,
      holdingHours,
      ...cost,
    });
  }

  const returns = trades.map((t) => t.netPnlPct);
  const metrics = computeMetrics({
    returnsPct: returns,
    periodsPerYear: timeframe === "1w" ? 52 : timeframe === "1d" ? 365 : 8760,
    riskPerTradePct: 0.01,
  });

  return { metrics, trades, heldByBar, rankings };
}

export async function fetchRotationCandles(
  symbols: string[],
  timeframe: LiveTimeframe,
  targetCount: number,
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) {
    out[s] = await loadBinanceHistory({ symbol: s, timeframe, targetCount });
  }
  return out;
}
