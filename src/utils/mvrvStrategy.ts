/**
 * MVRV-Z On-Chain Regime Filter.
 *
 * MVRV = Market Value / Realized Value. The "Z-score" version standardises
 * MVRV against its trailing mean/stdev. Historically, BTC tops occur at
 * MVRV-Z > 7 and major bottoms at MVRV-Z < 0 (or < -0.5 for capitulation).
 *
 * Research:
 *   - Glassnode / Coinmetrics methodology notes (public).
 *   - Koutmos (2023) "On-chain activity and Bitcoin pricing" (FRL).
 *   - Cong, Li, Wang (2023) "Tokenomics" section on realized cap as
 *     behavioural anchor.
 *
 * Data source: Coinmetrics Community API — free, no key required:
 *   https://community-api.coinmetrics.io/v4/timeseries/asset-metrics
 *   ?assets=btc&metrics=CapMVRVCur&frequency=1d&page_size=10000
 *
 * Strategy: long BTC when MVRV-Z between exitLow (-0.5) and entryHigh (7);
 * flat otherwise. We compute Z-score on a 2-year trailing window so the
 * signal adapts to the current cycle.
 */

export interface MvrvSample {
  time: number; // ms
  mvrv: number; // MCap / RealizedCap ratio
  marketCapUsd?: number;
  realizedCapUsd?: number;
  zScore: number | null; // Glassnode-style: (MCap - RealCap) / stdev(MCap)
  price?: number;
}

export interface MvrvConfig {
  /**
   * Raw MVRV ratio threshold above which the market is considered over-
   * heated. Historical calibration (Glassnode + Coinmetrics research):
   * major BTC tops printed MVRV > 3.5 (2013, 2017, 2021).
   */
  ratioTop: number;
  /**
   * Ratio below which the market is in capitulation. BTC bottoms in 2015,
   * 2018, 2022 each printed MVRV < 1.
   */
  ratioBottom: number;
  /**
   * Re-entry threshold after a top: wait until MVRV comes back down to this
   * level before considering a new long. Filters out "enter at 3.4, hit 3.6,
   * exit, re-enter immediately at 3.3" whipsaw.
   */
  ratioReEntryBelow: number;
}

export const DEFAULT_MVRV_CONFIG: MvrvConfig = {
  ratioTop: 3.5,
  ratioBottom: 1.0,
  ratioReEntryBelow: 2.0,
};

export interface MvrvTrade {
  openTime: number;
  closeTime: number;
  entryPrice: number;
  exitPrice: number;
  entryZ: number;
  exitZ: number;
  netReturnPct: number;
}

export interface MvrvBacktestReport {
  samples: MvrvSample[];
  trades: MvrvTrade[];
  totalReturnPct: number;
  buyAndHoldPct: number;
  maxDrawdownPct: number;
  timeInMarketPct: number;
  equityCurve: number[];
  currentZ: number | null;
  currentRegime: "enter" | "hold" | "flat" | "top-warning";
}

const COINMETRICS_URL =
  "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";

interface RawMetric {
  asset: string;
  time: string;
  CapMVRVCur?: string;
  PriceUSD?: string;
}

/**
 * Fetches BTC MVRV ratio + price from Coinmetrics' free community tier.
 * The Glassnode-style Z-score (which uses stdev of market-cap) needs the
 * raw market-cap series, which is gated behind Coinmetrics' paid tier.
 * Luckily the ratio itself is a well-researched signal when combined with
 * historically-calibrated thresholds.
 */
export async function fetchMvrvHistory(): Promise<MvrvSample[]> {
  const url = new URL(COINMETRICS_URL);
  url.searchParams.set("assets", "btc");
  url.searchParams.set("metrics", "CapMVRVCur,PriceUSD");
  url.searchParams.set("frequency", "1d");
  url.searchParams.set("page_size", "10000");
  url.searchParams.set("pretty", "false");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Coinmetrics fetch failed: ${res.status}`);
  const json = (await res.json()) as { data: RawMetric[] };
  const rows = json.data ?? [];
  const samples: MvrvSample[] = [];
  for (const r of rows) {
    const mvrv = r.CapMVRVCur ? parseFloat(r.CapMVRVCur) : NaN;
    const price = r.PriceUSD ? parseFloat(r.PriceUSD) : undefined;
    if (!isFinite(mvrv)) continue;
    samples.push({
      time: Date.parse(r.time),
      mvrv,
      zScore: null,
      price,
    });
  }
  samples.sort((a, b) => a.time - b.time);
  return samples;
}

export function computeRollingZ(
  samples: MvrvSample[],
  windowDays: number,
): MvrvSample[] {
  const out = samples.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    const start = Math.max(0, i - windowDays + 1);
    const window = out.slice(start, i + 1).map((s) => s.mvrv);
    if (window.length < 30) {
      out[i]!.zScore = null;
      continue;
    }
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance =
      window.reduce((s, v) => s + (v - mean) * (v - mean), 0) / window.length;
    const std = Math.sqrt(variance);
    out[i]!.zScore = std > 0 ? (out[i]!.mvrv - mean) / std : 0;
  }
  return out;
}

/**
 * Expanding-window Glassnode MVRV-Z Score:
 *   Z(t) = (MCap(t) - RealizedCap(t)) / stdev(MCap[0..t])
 *
 * This is the standard definition published by Glassnode/Coinmetrics and is
 * the version that reaches Z>7 at the 2013 / 2017 / 2021 tops and Z<0 at
 * major bottoms. When the raw market-cap series isn't available we fall
 * back to the ratio-based approximation.
 */
export function computeExpandingZ(samples: MvrvSample[]): MvrvSample[] {
  const out = samples.map((s) => ({ ...s }));
  let sumMcap = 0;
  let sumSqMcap = 0;
  let haveMcap = 0;
  // Fallback accumulators on the ratio
  let sumR = 0;
  let sumSqR = 0;
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    const mcap = s!.marketCapUsd;
    const rcap = s!.realizedCapUsd;
    if (mcap !== undefined && rcap !== undefined) {
      sumMcap += mcap;
      sumSqMcap += mcap * mcap;
      haveMcap++;
      if (haveMcap >= 365) {
        const mean = sumMcap / haveMcap;
        const variance = sumSqMcap / haveMcap - mean * mean;
        const std = Math.sqrt(Math.max(0, variance));
        out[i]!.zScore = std > 0 ? (mcap - rcap) / std : 0;
        continue;
      }
    }
    // Fallback: ratio-based Z (used when MCap data missing)
    sumR += s!.mvrv;
    sumSqR += s!.mvrv * s!.mvrv;
    const n = i + 1;
    if (n < 365) {
      out[i]!.zScore = null;
      continue;
    }
    const mean = sumR / n;
    const variance = sumSqR / n - mean * mean;
    const std = Math.sqrt(Math.max(0, variance));
    out[i]!.zScore = std > 0 ? (s!.mvrv - mean) / std : 0;
  }
  return out;
}

export function runMvrvBacktest(
  samples: MvrvSample[],
  config: MvrvConfig = DEFAULT_MVRV_CONFIG,
): MvrvBacktestReport {
  // Keep the zScore field populated (for the chart / UI) but the trade
  // decisions below operate on the raw MVRV ratio.
  const withZ = computeExpandingZ(samples);
  const trades: MvrvTrade[] = [];
  const equity = [1];
  let inPosition = false;
  let entryIdx = -1;
  let postTopCooldown = false;

  for (let i = 0; i < withZ.length; i++) {
    const s = withZ[i];
    if (s!.price === undefined) {
      equity.push(equity[equity.length - 1]!);
      continue;
    }

    // Lift cooldown once MVRV has cooled back to a moderate level.
    if (postTopCooldown && s!.mvrv < config.ratioReEntryBelow) {
      postTopCooldown = false;
    }

    if (!inPosition) {
      // Enter long when ratio is below the overheat threshold and cooldown
      // is inactive. Deep capitulation (ratio < 1) is NOT an exit — the
      // research treats it as the best buying window.
      if (!postTopCooldown && s!.mvrv < config.ratioTop) {
        inPosition = true;
        entryIdx = i;
      }
      equity.push(equity[equity.length - 1]!);
      continue;
    }

    // Daily-return update while held
    const prevPrice = withZ[i - 1]?.price;
    if (prevPrice && s!.price) {
      const dailyRet = s!.price / prevPrice - 1;
      equity.push(equity[equity.length - 1]! * (1 + dailyRet));
    } else {
      equity.push(equity[equity.length - 1]!);
    }

    // Exit at the euphoria top.
    if (s!.mvrv >= config.ratioTop) {
      const entry = withZ[entryIdx];
      if (entry!.price && s!.price && entry!.price > 0) {
        trades.push({
          openTime: entry!.time,
          closeTime: s!.time,
          entryPrice: entry!.price,
          exitPrice: s!.price,
          entryZ: entry!.mvrv,
          exitZ: s!.mvrv,
          netReturnPct: s!.price / entry!.price - 1,
        });
      }
      inPosition = false;
      entryIdx = -1;
      postTopCooldown = true;
    }
  }

  // Close any still-open position at the final bar
  if (inPosition && entryIdx >= 0) {
    const entry = withZ[entryIdx];
    const last = withZ[withZ.length - 1];
    if (entry!.price && last!.price && entry!.price > 0) {
      trades.push({
        openTime: entry!.time,
        closeTime: last!.time,
        entryPrice: entry!.price,
        exitPrice: last!.price,
        entryZ: entry!.mvrv,
        exitZ: last!.mvrv,
        netReturnPct: last!.price / entry!.price - 1,
      });
    }
  }

  // Compound the trades (not sum — they're compounded when held consecutively)
  const total = trades.reduce((acc, t) => acc * (1 + t.netReturnPct), 1) - 1;
  const first = samples[0]?.price;
  const last = samples[samples.length - 1]?.price;
  const buyHold = first && last ? last / first - 1 : 0;

  let peak = 1;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const tradesDays = trades.reduce(
    (s, t) => s + (t.closeTime - t.openTime) / 86400000,
    0,
  );
  const totalDays =
    ((withZ[withZ.length - 1]?.time ?? 0) - (withZ[0]?.time ?? 0)) / 86400000 ||
    1;
  const timeInMarket = Math.min(1, tradesDays / totalDays);

  const currentZ = withZ[withZ.length - 1]?.zScore ?? null;
  const currentMvrv = withZ[withZ.length - 1]?.mvrv ?? null;
  let currentRegime: MvrvBacktestReport["currentRegime"] = "flat";
  if (currentMvrv !== null) {
    if (currentMvrv >= config.ratioTop) currentRegime = "top-warning";
    else if (currentMvrv < config.ratioBottom) currentRegime = "enter";
    else if (currentMvrv < config.ratioReEntryBelow) currentRegime = "enter";
    else currentRegime = "hold";
  }

  return {
    samples: withZ,
    trades,
    totalReturnPct: total,
    buyAndHoldPct: buyHold,
    maxDrawdownPct: maxDd,
    timeInMarketPct: timeInMarket,
    equityCurve: equity,
    currentZ,
    currentRegime,
  };
}
