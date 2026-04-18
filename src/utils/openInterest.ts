/**
 * Binance Futures Open-Interest history fetcher.
 *
 * Endpoint: https://fapi.binance.com/futures/data/openInterestHist
 *   - Free, no auth
 *   - Returns max 30 days history
 *   - Period values: "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"
 *   - limit max 500
 *
 * Used by the OI + Taker-Imbalance strategy (Easley 2024, SSRN 4814346):
 * a spike in OI with aggressive taker-buy volume signals informed long
 * flow; mean-reverting within 4-8h if price is also above VWAP.
 */

export interface OiSample {
  time: number; // ms
  sumOpenInterest: number; // coins
  sumOpenInterestValueUsd: number; // USD notional
}

interface RawOi {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

const ENDPOINT = "https://fapi.binance.com/futures/data/openInterestHist";

export interface OiFetchOptions {
  symbol: string;
  period: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";
  limit?: number; // max 500
  signal?: AbortSignal;
}

export async function fetchOpenInterestHistory(
  options: OiFetchOptions,
): Promise<OiSample[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("symbol", options.symbol.toUpperCase());
  url.searchParams.set("period", options.period);
  url.searchParams.set("limit", String(Math.min(options.limit ?? 500, 500)));
  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) throw new Error(`Binance OI fetch failed: ${res.status}`);
  const rows: RawOi[] = await res.json();
  return rows
    .map((r) => ({
      time: r.timestamp,
      sumOpenInterest: parseFloat(r.sumOpenInterest),
      sumOpenInterestValueUsd: parseFloat(r.sumOpenInterestValue),
    }))
    .sort((a, b) => a.time - b.time);
}
