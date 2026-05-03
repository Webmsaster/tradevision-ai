import { Candle, atr } from "@/utils/indicators";

// ============================================================================
// Structural indicators: Pivots, VWAP, Bollinger Bands
// ============================================================================

export interface BollingerBands {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
  widthPct: (number | null)[];
}

export function bollingerBands(
  values: number[],
  period = 20,
  stdDevMult = 2,
): BollingerBands {
  const n = values.length;
  const middle: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const widthPct: (number | null)[] = new Array(n).fill(null);
  if (n < period) return { middle, upper, lower, widthPct };

  for (let i = period - 1; i < n; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((s, v) => s + v, 0) / period;
    const variance =
      window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + sd * stdDevMult;
    lower[i] = mean - sd * stdDevMult;
    // Phase 53 (R45-IND-1): use |mean| so the relative-width metric works
    // for any input series (returns/PnL series can have mean ≤ 0). The
    // previous `mean > 0` guard silently zeroed widthPct on negative-mean
    // inputs — fine for prices but a latent bug for any future use on
    // PnL/returns streams.
    widthPct[i] =
      Math.abs(mean) > 1e-12
        ? ((sd * stdDevMult * 2) / Math.abs(mean)) * 100
        : 0;
  }

  return { middle, upper, lower, widthPct };
}

export interface VwapPoint {
  vwap: number | null;
  upper1: number | null;
  lower1: number | null;
  upper2: number | null;
  lower2: number | null;
}

/**
 * Running VWAP with 1σ/2σ bands, reset at UTC midnight so each trading day
 * gets its own volume-weighted reference price (standard intraday convention).
 *
 * Phase 53 (R45-IND-2): INTRADAY ONLY. For ≥1d source candles the per-day
 * reset fires every bar, making vwap === typical price (single-bar
 * accumulator) and bands collapse to zero — meaningless. Callers feeding
 * daily/weekly series should use a different reference (anchored VWAP or
 * price-only equivalent).
 */
export function vwap(candles: Candle[]): VwapPoint[] {
  const out: VwapPoint[] = [];
  let cumVol = 0;
  let cumPV = 0;
  let cumPV2 = 0;
  let lastDay = -1;

  for (const c of candles) {
    const day = Math.floor(c.closeTime / (24 * 60 * 60 * 1000));
    if (day !== lastDay) {
      cumVol = 0;
      cumPV = 0;
      cumPV2 = 0;
      lastDay = day;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumPV += typical * c.volume;
    cumPV2 += typical * typical * c.volume;

    if (cumVol === 0) {
      out.push({
        vwap: null,
        upper1: null,
        lower1: null,
        upper2: null,
        lower2: null,
      });
      continue;
    }
    const vw = cumPV / cumVol;
    const variance = cumPV2 / cumVol - vw * vw;
    const sd = variance > 0 ? Math.sqrt(variance) : 0;
    out.push({
      vwap: vw,
      upper1: vw + sd,
      lower1: vw - sd,
      upper2: vw + 2 * sd,
      lower2: vw - 2 * sd,
    });
  }

  return out;
}

export interface PivotLevel {
  index: number;
  price: number;
  type: "high" | "low";
  strength: number; // how many bars it dominates
}

/**
 * Classic swing-pivot detection: a candle is a pivot high if its high is
 * greater than the `left` previous candles and greater than the `right` following
 * candles. Pivot low is the symmetric case. Only pivots that are fully confirmed
 * (i.e. have `right` candles after them) are emitted.
 */
export function findPivots(
  candles: Candle[],
  left = 5,
  right = 5,
): PivotLevel[] {
  const pivots: PivotLevel[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i - j]!.high >= c!.high) isHigh = false;
      if (candles[i - j]!.low <= c!.low) isLow = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i + j]!.high >= c!.high) isHigh = false;
      if (candles[i + j]!.low <= c!.low) isLow = false;
    }
    if (isHigh)
      pivots.push({
        index: i,
        price: c!.high,
        type: "high",
        strength: left + right,
      });
    if (isLow)
      pivots.push({
        index: i,
        price: c!.low,
        type: "low",
        strength: left + right,
      });
  }
  return pivots;
}

export interface KeyLevels {
  supports: number[];
  resistances: number[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  distanceToSupportPct: number | null;
  distanceToResistancePct: number | null;
}

/**
 * Extract the most relevant S/R levels near current price. Clusters nearby
 * pivots (within 0.3% of each other) and keeps the closest ones to the
 * current price for display.
 */
export function extractKeyLevels(
  pivots: PivotLevel[],
  currentPrice: number,
  maxLevels = 3,
): KeyLevels {
  const clusterTolerance = 0.003; // 0.3%

  const cluster = (levels: number[]): number[] => {
    const sorted = [...levels].sort((a, b) => a - b);
    const clustered: number[] = [];
    for (const l of sorted) {
      const last = clustered[clustered.length - 1];
      if (last !== undefined && Math.abs(l - last) / last < clusterTolerance) {
        clustered[clustered.length - 1] = (last + l) / 2;
      } else {
        clustered.push(l);
      }
    }
    return clustered;
  };

  const highs = cluster(
    pivots.filter((p) => p.type === "high").map((p) => p.price),
  );
  const lows = cluster(
    pivots.filter((p) => p.type === "low").map((p) => p.price),
  );

  const supports = lows
    .filter((l) => l < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, maxLevels);
  const resistances = highs
    .filter((h) => h > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, maxLevels);

  const nearestSupport = supports[0] ?? null;
  const nearestResistance = resistances[0] ?? null;

  return {
    supports,
    resistances,
    nearestSupport,
    nearestResistance,
    distanceToSupportPct:
      nearestSupport !== null
        ? ((currentPrice - nearestSupport) / currentPrice) * 100
        : null,
    distanceToResistancePct:
      nearestResistance !== null
        ? ((nearestResistance - currentPrice) / currentPrice) * 100
        : null,
  };
}

// ============================================================================
// Market structure: HH/HL/LH/LL + Break-of-Structure / Change-of-Character
// ============================================================================

export type StructureState = "bullish" | "bearish" | "undetermined";
export type StructureEvent =
  | "BOS-up"
  | "BOS-down"
  | "CHoCH-up"
  | "CHoCH-down"
  | "none";

export interface MarketStructure {
  state: StructureState;
  lastEvent: StructureEvent;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  previousSwingHigh: number | null;
  previousSwingLow: number | null;
}

/**
 * Derives market structure from the confirmed pivot sequence:
 * - HH/HL sequence = bullish
 * - LH/LL sequence = bearish
 * - Break of the most recent swing in the trend direction = BOS (continuation)
 * - Break against the trend = CHoCH (change of character / potential reversal)
 */
export function analyzeMarketStructure(
  candles: Candle[],
  pivots: PivotLevel[],
): MarketStructure {
  const last = candles[candles.length - 1];
  if (!last || pivots.length < 2) {
    return {
      state: "undetermined",
      lastEvent: "none",
      lastSwingHigh: null,
      lastSwingLow: null,
      previousSwingHigh: null,
      previousSwingLow: null,
    };
  }

  const highs = pivots.filter((p) => p.type === "high");
  const lows = pivots.filter((p) => p.type === "low");

  const lastHigh = highs[highs.length - 1] ?? null;
  const prevHigh = highs[highs.length - 2] ?? null;
  const lastLow = lows[lows.length - 1] ?? null;
  const prevLow = lows[lows.length - 2] ?? null;

  let state: StructureState = "undetermined";
  if (lastHigh && prevHigh && lastLow && prevLow) {
    if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price)
      state = "bullish";
    else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price)
      state = "bearish";
  }

  let lastEvent: StructureEvent = "none";
  const price = last.close;
  if (state === "bullish" && lastHigh && price > lastHigh.price)
    lastEvent = "BOS-up";
  else if (state === "bearish" && lastLow && price < lastLow.price)
    lastEvent = "BOS-down";
  else if (state === "bearish" && lastHigh && price > lastHigh.price)
    lastEvent = "CHoCH-up";
  else if (state === "bullish" && lastLow && price < lastLow.price)
    lastEvent = "CHoCH-down";

  return {
    state,
    lastEvent,
    lastSwingHigh: lastHigh?.price ?? null,
    lastSwingLow: lastLow?.price ?? null,
    previousSwingHigh: prevHigh?.price ?? null,
    previousSwingLow: prevLow?.price ?? null,
  };
}

// ============================================================================
// Setup classifier
// ============================================================================

export type SetupType =
  | "trend-continuation"
  | "pullback-entry"
  | "breakout"
  | "reversal"
  | "range-fade"
  | "indecision";

export interface SetupClassification {
  type: SetupType;
  description: string;
  playbook: string;
}

/**
 * Given current structure/key-levels/signal direction, classify the playbook.
 * Each playbook carries an English description + a plain-language trade plan
 * that downstream UI uses to build the narrative panel.
 */
export function classifySetup(
  signalAction: "long" | "short" | "flat",
  structure: MarketStructure,
  keyLevels: KeyLevels,
  currentPrice: number,
  atrValue: number | null,
): SetupClassification {
  if (signalAction === "flat" || structure.state === "undetermined") {
    return {
      type: "indecision",
      description:
        "No clear playbook — market structure is undetermined or signals cancel out.",
      playbook:
        "Stand aside. Let price show a direction before committing capital.",
    };
  }

  const isLong = signalAction === "long";
  const alignsWithStructure = isLong
    ? structure.state === "bullish"
    : structure.state === "bearish";

  const nearLevel =
    atrValue && keyLevels.nearestSupport && keyLevels.nearestResistance
      ? isLong
        ? Math.abs(currentPrice - keyLevels.nearestSupport) < atrValue
        : Math.abs(keyLevels.nearestResistance - currentPrice) < atrValue
      : false;

  if (structure.lastEvent === "BOS-up" && isLong) {
    return {
      type: "breakout",
      description:
        "Break of structure to the upside — price has taken out a prior swing high.",
      playbook:
        "Breakouts often retest the broken level. Ideal entry: wait for a retest of the recent swing high as new support, or enter on strength with a tight stop below the breakout candle.",
    };
  }

  if (structure.lastEvent === "BOS-down" && !isLong) {
    return {
      type: "breakout",
      description:
        "Break of structure to the downside — price has taken out a prior swing low.",
      playbook:
        "Look for a retest of the broken swing low as new resistance, or short into strength failure with a stop above the breakout candle.",
    };
  }

  if (structure.lastEvent === "CHoCH-up" && isLong) {
    return {
      type: "reversal",
      description:
        "Change of character: price reclaimed a prior swing high in a previously bearish structure.",
      playbook:
        "Reversals are high-reward but low probability. Wait for confirmation (higher low after the CHoCH), tight stops, and be willing to scratch the trade fast.",
    };
  }

  if (structure.lastEvent === "CHoCH-down" && !isLong) {
    return {
      type: "reversal",
      description:
        "Change of character: price broke a prior swing low in a previously bullish structure.",
      playbook:
        "Short the reaction into resistance, stop above the swing high that failed, target the next liquidity pool or prior demand zone.",
    };
  }

  if (alignsWithStructure && nearLevel) {
    return {
      type: "pullback-entry",
      description: `Pullback into ${isLong ? "support" : "resistance"} within an existing ${structure.state} trend.`,
      playbook: isLong
        ? "Buy the dip into the nearest support with a stop below the swing low. Target the prior swing high or a measured move extension."
        : "Short the rally into the nearest resistance with a stop above the swing high. Target the prior swing low.",
    };
  }

  if (alignsWithStructure) {
    return {
      type: "trend-continuation",
      description: `Trend continuation in a ${structure.state} structure.`,
      playbook:
        "Follow the trend with disciplined position sizing. Trail the stop behind each new swing low/high to lock in profits as structure evolves.",
    };
  }

  return {
    type: "range-fade",
    description:
      "Signal fires counter to the prevailing structure — likely a mean-reversion attempt.",
    playbook:
      "Counter-trend fades have a lower base rate. Consider smaller size, a tighter stop, and exit early at the first sign of trend resumption.",
  };
}

// ============================================================================
// Historical base rate — simulate the same playbook over prior candles
// ============================================================================

export interface BaseRate {
  samples: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  confidenceLower: number;
  confidenceUpper: number;
}

/**
 * Historical base rate for the current setup: walks forward over the past
 * candles, whenever the same structural condition (state + BOS/CHoCH event)
 * appeared, records the next-move outcome vs a 2×ATR stop / 3×ATR target.
 * Returns the win rate with a Wilson 95% confidence interval.
 */
export function computeBaseRate(
  candles: Candle[],
  signalAction: "long" | "short" | "flat",
  setup: SetupType,
): BaseRate | null {
  if (signalAction === "flat" || candles.length < 100) return null;
  const atrArr = atr(candles, 14);

  const samples: number[] = [];
  const lookback = Math.min(candles.length - 30, 800);

  for (let i = 30; i < lookback; i++) {
    const slice = candles.slice(0, i + 1);
    const pivots = findPivots(slice, 3, 3);
    const structure = analyzeMarketStructure(slice, pivots);
    const priceHere = slice[slice.length - 1]!.close;
    const atrHere = atrArr[i];
    if (!atrHere) continue;

    const alignsBull = signalAction === "long" && structure.state === "bullish";
    const alignsBear =
      signalAction === "short" && structure.state === "bearish";
    const alignsBreak =
      (setup === "breakout" &&
        ((signalAction === "long" && structure.lastEvent === "BOS-up") ||
          (signalAction === "short" && structure.lastEvent === "BOS-down"))) ||
      (setup === "reversal" &&
        ((signalAction === "long" && structure.lastEvent === "CHoCH-up") ||
          (signalAction === "short" && structure.lastEvent === "CHoCH-down")));

    if (!(alignsBull || alignsBear || alignsBreak)) continue;

    const slDistance = atrHere * 2;
    const tpDistance = atrHere * 3;
    const sl =
      signalAction === "long" ? priceHere - slDistance : priceHere + slDistance;
    const tp =
      signalAction === "long" ? priceHere + tpDistance : priceHere - tpDistance;

    let outcome = 0;
    for (let j = i + 1; j < Math.min(i + 60, candles.length); j++) {
      const c = candles[j];
      if (signalAction === "long") {
        if (c!.low <= sl) {
          outcome = -1;
          break;
        }
        if (c!.high >= tp) {
          outcome = 1.5;
          break;
        }
      } else {
        if (c!.high >= sl) {
          outcome = -1;
          break;
        }
        if (c!.low <= tp) {
          outcome = 1.5;
          break;
        }
      }
    }
    if (outcome !== 0) samples.push(outcome);
  }

  if (samples.length < 5) return null;
  const wins = samples.filter((s) => s > 0).length;
  const losses = samples.filter((s) => s < 0).length;
  const winRate = wins / samples.length;
  const avgR = samples.reduce((s, v) => s + v, 0) / samples.length;

  // Wilson score interval (95%)
  const z = 1.96;
  const n = samples.length;
  const denom = 1 + (z * z) / n;
  const center = (winRate + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((winRate * (1 - winRate)) / n + (z * z) / (4 * n * n))) /
    denom;

  return {
    samples: n,
    wins,
    losses,
    winRate,
    avgR,
    confidenceLower: Math.max(0, center - margin),
    confidenceUpper: Math.min(1, center + margin),
  };
}
