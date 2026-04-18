import type { Candle } from "@/utils/indicators";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

// Binance paginated history loader. Binance returns max 1000 candles per call,
// so for longer windows we page backwards from `now` until we have `targetCount`
// or hit the requested `startTime`.

export interface LoadHistoryOptions {
  symbol: string;
  timeframe: LiveTimeframe;
  targetCount: number; // e.g. 10000 candles
  signal?: AbortSignal;
}

const TF_MS: Record<LiveTimeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

type RawKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function parseKline(row: RawKline): Candle {
  return {
    openTime: row[0],
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: row[6],
    isFinal: true,
  };
}

/**
 * Loads up to `targetCount` historical candles from Binance by paging backwards.
 * Each page is a REST call with `endTime` set to the oldest openTime seen so far.
 * Respects an optional AbortSignal so the caller can cancel.
 */
export async function loadBinanceHistory({
  symbol,
  timeframe,
  targetCount,
  signal,
}: LoadHistoryOptions): Promise<Candle[]> {
  const pageSize = 1000;
  const candles: Candle[] = [];
  let endTime: number | undefined = undefined;

  while (candles.length < targetCount) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("limit", String(pageSize));
    if (endTime) url.searchParams.set("endTime", String(endTime));

    const res = await fetch(url.toString(), { signal });
    if (!res.ok) {
      throw new Error(`Binance history fetch failed: ${res.status}`);
    }
    const rows: RawKline[] = await res.json();
    if (!rows || rows.length === 0) break;

    const page = rows.map(parseKline);
    // API returns oldest first, so prepend
    candles.unshift(...page);

    // Deduplicate: cut off anything after endTime
    if (endTime) {
      while (
        candles.length > 0 &&
        candles[candles.length - 1].closeTime >= endTime
      ) {
        candles.pop();
      }
    }

    // Step endTime back one candle-width from the oldest openTime just pulled
    const oldest = page[0];
    endTime = oldest.openTime - TF_MS[timeframe];

    // If Binance returned fewer than pageSize, we've hit the start of the listing
    if (rows.length < pageSize) break;
  }

  // Trim to exactly targetCount (keep the most recent)
  if (candles.length > targetCount) {
    return candles.slice(-targetCount);
  }
  return candles;
}

/**
 * Compute how many days of market time a given candle count covers at a given TF.
 * Useful for explaining "this backtest covers X days" in the UI.
 */
export function historyDays(
  candleCount: number,
  timeframe: LiveTimeframe,
): number {
  return (candleCount * TF_MS[timeframe]) / (24 * 60 * 60 * 1000);
}
