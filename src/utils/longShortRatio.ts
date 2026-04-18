/**
 * Binance Futures global long/short account-ratio fetcher.
 *
 * Endpoint: https://fapi.binance.com/futures/data/globalLongShortAccountRatio
 *   - Free, no auth
 *   - period: 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d
 *   - limit: max 500
 *   - Historical depth: ~30 days
 *
 * Used by Funding-Extreme Contrarian (Kharat 2025): persistent high funding
 * combined with L/S ratio > 2.5 signals crowded-long market → short signal.
 */

export interface LongShortRatioSample {
  time: number; // ms
  longShortRatio: number;
  longAccount: number; // fraction (0..1)
  shortAccount: number;
}

interface RawLs {
  symbol: string;
  longShortRatio: string;
  longAccount: string;
  shortAccount: string;
  timestamp: number;
}

const ENDPOINT =
  "https://fapi.binance.com/futures/data/globalLongShortAccountRatio";

export interface LsFetchOptions {
  symbol: string;
  period: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchLongShortRatio(
  options: LsFetchOptions,
): Promise<LongShortRatioSample[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("symbol", options.symbol.toUpperCase());
  url.searchParams.set("period", options.period);
  url.searchParams.set("limit", String(Math.min(options.limit ?? 500, 500)));
  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) throw new Error(`L/S ratio fetch failed: ${res.status}`);
  const rows: RawLs[] = await res.json();
  return rows
    .map((r) => ({
      time: r.timestamp,
      longShortRatio: parseFloat(r.longShortRatio),
      longAccount: parseFloat(r.longAccount),
      shortAccount: parseFloat(r.shortAccount),
    }))
    .sort((a, b) => a.time - b.time);
}
