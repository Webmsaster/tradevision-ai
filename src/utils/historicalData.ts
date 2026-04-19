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
  /** Max pagination steps. Default 30 (= 30 000 candles). Raise for deep history scans. */
  maxPages?: number;
}

const TF_MS: Record<LiveTimeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
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
    // Binance kline schema index 9 = takerBuyBaseAssetVolume
    takerBuyVolume: parseFloat(row[9]),
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
  maxPages,
}: LoadHistoryOptions): Promise<Candle[]> {
  const pageSize = 1000;
  const tfMs = TF_MS[timeframe];
  // Seen-set avoids duplicates across overlapping pages
  const seen = new Set<number>();
  const candles: Candle[] = [];
  let endTime: number | undefined = undefined;

  const cap = maxPages && maxPages > 0 ? maxPages : 30;
  // Hard cap on iterations as a safety net
  for (let page = 0; page < cap && candles.length < targetCount; page++) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("limit", String(pageSize));
    if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));

    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`Binance history fetch failed: ${res.status}`);
    const rows: RawKline[] = await res.json();
    if (!rows || rows.length === 0) break;

    const batch = rows.map(parseKline);
    // Prepend only candles we haven't seen yet
    const fresh: Candle[] = [];
    for (const c of batch) {
      if (!seen.has(c.openTime)) {
        seen.add(c.openTime);
        fresh.push(c);
      }
    }
    if (fresh.length === 0) break;
    candles.unshift(...fresh);

    // Next page: ask for candles older than the oldest we now have
    const oldestOpen = batch[0].openTime;
    endTime = oldestOpen - tfMs;

    // Binance returned fewer than pageSize → we hit the start of listed data
    if (rows.length < pageSize) break;
  }

  candles.sort((a, b) => a.openTime - b.openTime);
  return candles.length > targetCount ? candles.slice(-targetCount) : candles;
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
