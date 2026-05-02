/**
 * BTC Dominance live snapshot via CoinGecko's free /global endpoint.
 *
 * Research: Shen/Urquhart 2024 arxiv working paper documents mean-reverting
 * cycles in BTC dominance. Practitioner rule (Delphi Digital 2023 reports):
 *   - Rising dominance + BTC above 200d-SMA  → stay in BTC
 *   - Falling dominance + BTC above 200d-SMA → rotate into ETH/SOL (alt-season)
 *   - Falling dominance + BTC below 200d-SMA → risk-off, stablecoins
 *
 * Historical daily BTC.D requires CoinGecko Pro. The free endpoint gives
 * current dominance; we build a short rolling window by calling it
 * periodically and computing trend direction from the last N snapshots
 * captured during the session.
 */

export interface DominanceSnapshot {
  capturedAt: number;
  btcDominancePct: number;
  ethDominancePct: number;
  totalMarketCapUsd: number;
  btcPriceUsd: number;
  marketCapChange24hPct: number;
}

export interface DominanceRegime {
  btcDominancePct: number;
  ethDominancePct: number;
  bias: "btc-strong" | "alt-season" | "risk-off" | "neutral";
  interpretation: string;
  trend: "rising" | "falling" | "flat" | "unknown";
}

const COINGECKO_GLOBAL = "https://api.coingecko.com/api/v3/global";

interface RawGlobal {
  data: {
    market_cap_percentage: Record<string, number>;
    total_market_cap: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
  };
}

export async function fetchDominance(): Promise<DominanceSnapshot> {
  const res = await fetch(COINGECKO_GLOBAL);
  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
  const json = (await res.json()) as RawGlobal;
  const d = json.data;
  return {
    capturedAt: Date.now(),
    btcDominancePct: d.market_cap_percentage.btc ?? 0,
    ethDominancePct: d.market_cap_percentage.eth ?? 0,
    totalMarketCapUsd: d.total_market_cap.usd ?? 0,
    btcPriceUsd: 0, // not provided by this endpoint; callers can fill via separate call
    marketCapChange24hPct: d.market_cap_change_percentage_24h_usd ?? 0,
  };
}

/**
 * Classifies a live dominance reading without any historical series — it's a
 * snapshot-only interpretation. The `trend` field is "unknown" unless caller
 * provides a list of previous readings.
 */
export function classifyDominance(
  snap: DominanceSnapshot,
  btcAbove200dSma: boolean | null,
  history: DominanceSnapshot[] = [],
): DominanceRegime {
  const d = snap.btcDominancePct;
  let trend: DominanceRegime["trend"] = "unknown";
  if (history.length >= 3) {
    const first = history[0]!.btcDominancePct;
    const last = history[history.length - 1]!.btcDominancePct;
    const delta = last - first;
    if (delta > 0.5) trend = "rising";
    else if (delta < -0.5) trend = "falling";
    else trend = "flat";
  }

  let bias: DominanceRegime["bias"];
  let interpretation: string;

  if (btcAbove200dSma === false) {
    bias = "risk-off";
    interpretation =
      "BTC below 200d-SMA — macro risk-off regime. Practitioner rules say avoid long alts; cash or stablecoins preferred regardless of dominance.";
  } else if (d > 55 && trend !== "falling") {
    bias = "btc-strong";
    interpretation = `BTC dominance ${d.toFixed(1)}% (rising/flat) — fresh capital still prefers BTC, alts typically underperform. Overweight BTC.`;
  } else if (d < 50 && trend === "falling") {
    bias = "alt-season";
    interpretation = `BTC dominance ${d.toFixed(1)}% and falling — classic alt-rotation signal. Practitioners move part of BTC allocation into ETH/SOL.`;
  } else {
    bias = "neutral";
    interpretation = `BTC dominance ${d.toFixed(1)}% without a clear trend — no rotation signal yet. Stay with baseline allocation.`;
  }

  return {
    btcDominancePct: d,
    ethDominancePct: snap.ethDominancePct,
    bias,
    interpretation,
    trend,
  };
}
