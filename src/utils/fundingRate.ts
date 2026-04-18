/**
 * Binance Futures funding-rate utility.
 *
 * Research basis: retail positioning asymmetrically pushes funding during
 * euphoric/panic phases. Extreme positive funding = crowded longs (potential
 * short-squeeze-reversal setup). Extreme negative funding = crowded shorts.
 * See cfbenchmarks.com "Revisiting the Bitcoin Basis" and BingX funding-rate
 * arbitrage guide.
 *
 * We pull the last 100 funding events (each = 8h period on Binance) to both
 * measure the *current* reading and its recent z-score against the trailing
 * window.
 */

export interface FundingEvent {
  symbol: string;
  fundingTime: number;
  fundingRate: number; // e.g. 0.0001 = 0.01% per 8h period
}

export interface FundingSnapshot {
  latest: FundingEvent;
  recent: FundingEvent[];
  mean: number;
  stdDev: number;
  zScore: number;
  annualisedPct: number;
  regime:
    | "extreme-long-crowded"
    | "long-crowded"
    | "neutral"
    | "short-crowded"
    | "extreme-short-crowded";
  reversalBias: "long" | "short" | "none";
}

type RawFunding = { symbol: string; fundingTime: number; fundingRate: string };

const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1/fundingRate";

export async function fetchFundingHistory(
  symbol: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<FundingEvent[]> {
  // Binance /fundingRate pagination quirks:
  //   - No time param → returns last ~200 rows.
  //   - With startTime → returns up to 1000 rows starting from startTime
  //     (oldest first). This is how we page forward through the whole
  //     history.
  // Strategy: start at the genesis of futures (Sep 2019), advance
  // startTime = lastSeen + 1ms until we hit the "now" horizon.
  const all: FundingEvent[] = [];
  const seen = new Set<number>();
  let startTime = 1567900800000; // 2019-09-08, before BTC perpetual launch
  const maxPages = Math.max(5, Math.ceil(limit / 800));

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(BINANCE_FAPI);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(startTime));
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`Funding history fetch failed: ${res.status}`);
    const rows: RawFunding[] = await res.json();
    if (!rows || rows.length === 0) break;
    const fresh: FundingEvent[] = [];
    for (const r of rows) {
      if (!seen.has(r.fundingTime)) {
        seen.add(r.fundingTime);
        fresh.push({
          symbol: r.symbol,
          fundingTime: r.fundingTime,
          fundingRate: parseFloat(r.fundingRate),
        });
      }
    }
    if (fresh.length === 0) break;
    all.push(...fresh);
    const newestInBatch = rows[rows.length - 1].fundingTime;
    if (newestInBatch <= startTime) break;
    startTime = newestInBatch + 1;
  }

  const sorted = all.sort((a, b) => a.fundingTime - b.fundingTime);
  return sorted.length > limit ? sorted.slice(-limit) : sorted;
}

/**
 * Computes the funding-rate snapshot: current rate, z-score versus the last
 * `recent.length` observations, implied annualised yield, and a regime label
 * plus a reversal bias useful as an additional signal input.
 *
 * Thresholds: >2σ above trailing mean OR >0.03%/8h absolute = "extreme".
 */
export function analyzeFunding(events: FundingEvent[]): FundingSnapshot | null {
  if (events.length < 10) return null;
  const sorted = [...events].sort((a, b) => a.fundingTime - b.fundingTime);
  const latest = sorted[sorted.length - 1];
  const rates = sorted.slice(0, -1).map((e) => e.fundingRate);
  const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
  const variance =
    rates.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rates.length;
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? (latest.fundingRate - mean) / stdDev : 0;

  // Binance perpetual settles funding every 8h → 3 times per day → 1095 per year
  const annualisedPct = latest.fundingRate * 3 * 365 * 100;

  let regime: FundingSnapshot["regime"];
  if (latest.fundingRate > 0.0003 || zScore > 2.5)
    regime = "extreme-long-crowded";
  else if (latest.fundingRate > 0.0001 || zScore > 1) regime = "long-crowded";
  else if (latest.fundingRate < -0.0003 || zScore < -2.5)
    regime = "extreme-short-crowded";
  else if (latest.fundingRate < -0.0001 || zScore < -1)
    regime = "short-crowded";
  else regime = "neutral";

  // Reversal bias: crowded long side → potential short; crowded short → potential long
  let reversalBias: FundingSnapshot["reversalBias"] = "none";
  if (regime === "extreme-long-crowded") reversalBias = "short";
  else if (regime === "extreme-short-crowded") reversalBias = "long";

  return {
    latest,
    recent: sorted,
    mean,
    stdDev,
    zScore,
    annualisedPct,
    regime,
    reversalBias,
  };
}

export function describeFundingRegime(r: FundingSnapshot["regime"]): string {
  switch (r) {
    case "extreme-long-crowded":
      return "Funding extreme positive — longs are crowded and paying heavily; historically a setup for short-squeezes-down (reversal) or continuation with sharper drawdowns.";
    case "long-crowded":
      return "Funding positive — longs are slightly crowded.";
    case "extreme-short-crowded":
      return "Funding extreme negative — shorts are crowded and paying heavily; historically a setup for short-squeeze rallies.";
    case "short-crowded":
      return "Funding negative — shorts are slightly crowded.";
    case "neutral":
      return "Funding near zero — no positioning imbalance.";
  }
}
