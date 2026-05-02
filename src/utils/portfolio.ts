/**
 * Portfolio allocator for multi-strategy ensemble.
 *
 * Based on research synthesis (Thorp, Lopez de Prado HRP, Moreira/Muir
 * vol-targeting, AQR rebalancing, DeMiguel 1/N):
 *
 *   1. Start with inverse-vol weights (robust baseline, beats 1/N only
 *      marginally but avoids concentration).
 *   2. Tilt by sqrt(OOS Sharpe) as mild edge signal.
 *   3. Cap per-strategy weight at 40% (concentration control).
 *   4. Apply correlation haircut: w_i *= (1 - 0.5 * avg_corr_to_others).
 *   5. Size portfolio to vol-target 15% p.a. with max leverage 2.0.
 *   6. Per-strategy quarter-Kelly cap: min(w, 0.25 * μ/σ²).
 *   7. DD-governor: if rolling-60d DD < -12%, half size. If < -20%, stop.
 *
 * All of these are research-validated heuristics; none is magic. The
 * portfolio is only as good as the underlying edges.
 */

export interface StrategyStats {
  name: string;
  returnsPct: number[]; // per-period decimal returns (0.01 = 1%)
  periodsPerYear: number; // for annualisation (8760 for 1h, 252 for 1d)
}

export interface StrategyMetrics {
  name: string;
  meanPct: number; // annualised mean
  stdDevPct: number; // annualised stdev
  sharpe: number;
  cappedSharpe: number; // Sharpe capped at 4 (deflated-Sharpe research)
  kellyFull: number; // full-Kelly fraction: μ / σ²
  quarterKelly: number;
  n: number;
}

export function computeMetrics(s: StrategyStats): StrategyMetrics {
  const n = s.returnsPct.length;
  if (n === 0) {
    return {
      name: s.name,
      meanPct: 0,
      stdDevPct: 0,
      sharpe: 0,
      cappedSharpe: 0,
      kellyFull: 0,
      quarterKelly: 0,
      n: 0,
    };
  }
  const mean = s.returnsPct.reduce((a, b) => a + b, 0) / n;
  const variance =
    s.returnsPct.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  const meanA = mean * s.periodsPerYear;
  const stdA = std * Math.sqrt(s.periodsPerYear);
  const sharpe = stdA > 0 ? meanA / stdA : 0;
  const cappedSharpe = Math.max(-4, Math.min(4, sharpe));
  const kellyFull = stdA > 0 ? meanA / (stdA * stdA) : 0;
  return {
    name: s.name,
    meanPct: meanA,
    stdDevPct: stdA,
    sharpe,
    cappedSharpe,
    kellyFull,
    quarterKelly: 0.25 * kellyFull,
    n,
  };
}

export interface PortfolioConfig {
  volTargetPct: number; // e.g. 0.15 = 15% p.a.
  maxLeverage: number; // e.g. 2.0
  maxWeightPerStrategy: number; // e.g. 0.40
  correlationHaircut: number; // e.g. 0.5 (Lopez de Prado heuristic)
  useQuarterKellyCap: boolean;
  ddHalfSize: number; // rolling DD below which half size (-0.12)
  ddStop: number; // rolling DD below which stop (-0.20)
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  volTargetPct: 0.15,
  maxLeverage: 2.0,
  maxWeightPerStrategy: 0.4,
  correlationHaircut: 0.5,
  useQuarterKellyCap: true,
  ddHalfSize: -0.12,
  ddStop: -0.2,
};

export interface AllocationRow {
  name: string;
  rawWeight: number;
  correlationHaircut: number;
  kellyCap: number;
  finalWeight: number;
  cappedSharpe: number;
  stdevPct: number;
}

export interface PortfolioAllocation {
  rows: AllocationRow[];
  portfolioStdevPct: number;
  leverage: number;
  effectiveExposureSum: number;
  ddGovernor: "full" | "half" | "stop";
}

/**
 * Compute correlation matrix from aligned returns. Strategies must have the
 * same length — caller is responsible for resampling/aligning beforehand.
 */
export function correlationMatrix(returns: number[][]): number[][] {
  const n = returns.length;
  const out: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  if (n === 0) return out;
  const means = returns.map(
    (r) => r.reduce((a, b) => a + b, 0) / Math.max(1, r.length),
  );
  const stds = returns.map((r, i) => {
    const m = means[i];
    const v =
      r.reduce((a, b) => a + (b - m!) * (b - m!), 0) / Math.max(1, r.length);
    return Math.sqrt(v);
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        out[i]![j] = 1;
        continue;
      }
      const len = Math.min(returns[i]!.length, returns[j]!.length);
      let num = 0;
      for (let k = 0; k < len; k++) {
        num += (returns[i]![k] - means[i]!) * (returns[j]![k] - means[j]!);
      }
      num /= Math.max(1, len);
      const denom = stds[i]! * stds[j]!;
      out[i]![j] = denom > 0 ? num / denom : 0;
    }
  }
  return out;
}

/**
 * Allocate capital across strategies given their return series. All series
 * should be aligned (same length, same period). Returns both the raw weights
 * and the final leveraged exposure.
 */
export function allocate(
  strategies: StrategyStats[],
  config: PortfolioConfig = DEFAULT_PORTFOLIO_CONFIG,
  currentDrawdown = 0,
): PortfolioAllocation {
  const metrics = strategies.map(computeMetrics);
  const valid = metrics.filter((m) => m.stdDevPct > 0 && m.n > 10);
  if (valid.length === 0) {
    return {
      rows: metrics.map((m) => ({
        name: m.name,
        rawWeight: 0,
        correlationHaircut: 0,
        kellyCap: 0,
        finalWeight: 0,
        cappedSharpe: m.cappedSharpe,
        stdevPct: m.stdDevPct,
      })),
      portfolioStdevPct: 0,
      leverage: 0,
      effectiveExposureSum: 0,
      ddGovernor: "full",
    };
  }

  // Raw: inverse-vol × sqrt(max(Sharpe, 0.3))  — robust base + mild edge tilt
  const raws = valid.map((m) => {
    const edgeTilt = Math.sqrt(Math.max(0.3, m.cappedSharpe));
    return (1 / m.stdDevPct) * edgeTilt;
  });
  const rawSum = raws.reduce((a, b) => a + b, 0);
  let weights = raws.map((r) => r / rawSum);

  // Concentration cap
  weights = weights.map((w) => Math.min(w, config.maxWeightPerStrategy));

  // Correlation haircut
  const aligned = valid.map(
    (m) => strategies.find((s) => s.name === m.name)!.returnsPct,
  );
  const corr = correlationMatrix(aligned);
  const avgCorr = valid.map((_, i) => {
    if (valid.length <= 1) return 0;
    let sum = 0;
    for (let j = 0; j < valid.length; j++) {
      if (i !== j) sum += Math.abs(corr[i]![j]);
    }
    return sum / (valid.length - 1);
  });
  const haircutWeights = weights.map(
    (w, i) => w * (1 - config.correlationHaircut * avgCorr[i]!),
  );

  // Quarter-Kelly cap per strategy
  const kellyCaps = valid.map((m) =>
    config.useQuarterKellyCap ? Math.max(0, m.quarterKelly) : Infinity,
  );
  const afterKelly = haircutWeights.map((w, i) => Math.min(w, kellyCaps[i]!));

  // Portfolio stdev (simple: sqrt(w' Σ w) using corr + stds)
  const n = valid.length;
  let portVar = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      portVar +=
        afterKelly[i]! *
        afterKelly[j]! *
        valid[i]!.stdDevPct *
        valid[j]!.stdDevPct *
        corr[i]![j];
    }
  }
  const portStd = Math.sqrt(Math.max(0, portVar));

  // Leverage scalar to hit vol target
  const leverage =
    portStd > 0
      ? Math.min(config.maxLeverage, config.volTargetPct / portStd)
      : 0;

  // DD governor
  let ddFactor = 1;
  let governor: PortfolioAllocation["ddGovernor"] = "full";
  if (currentDrawdown <= config.ddStop) {
    ddFactor = 0;
    governor = "stop";
  } else if (currentDrawdown <= config.ddHalfSize) {
    ddFactor = 0.5;
    governor = "half";
  }

  const finalWeights = afterKelly.map((w) => w * leverage * ddFactor);

  const rows: AllocationRow[] = metrics.map((m) => {
    const idx = valid.findIndex((v) => v.name === m.name);
    if (idx < 0) {
      return {
        name: m.name,
        rawWeight: 0,
        correlationHaircut: 0,
        kellyCap: 0,
        finalWeight: 0,
        cappedSharpe: m.cappedSharpe,
        stdevPct: m.stdDevPct,
      };
    }
    return {
      name: m.name,
      rawWeight: weights[idx],
      correlationHaircut: avgCorr[idx],
      kellyCap: kellyCaps[idx],
      finalWeight: finalWeights[idx],
      cappedSharpe: m.cappedSharpe,
      stdevPct: m.stdDevPct,
    };
  });

  return {
    rows,
    portfolioStdevPct: portStd * leverage * ddFactor,
    leverage,
    effectiveExposureSum: finalWeights.reduce((a, b) => a + b, 0),
    ddGovernor: governor,
  };
}
