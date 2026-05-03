/**
 * Bybit V5 historical kline fetcher.
 *
 * Endpoint: https://api.bybit.com/v5/market/kline
 *   - Free, no auth
 *   - category=spot|linear (linear = USDT perp)
 *   - interval: 1, 3, 5, 15, 30, 60, 120, 240, 360, 720, D, W, M (minutes for numeric)
 *   - max 1000 rows per call
 *
 * Used to backtest Bybit basis (perp - spot) historically.
 */

import type { Candle } from "@/utils/indicators";

const BYBIT_KLINE_URL = "https://api.bybit.com/v5/market/kline";

export type BybitCategory = "spot" | "linear";
export type BybitInterval =
  | "1"
  | "3"
  | "5"
  | "15"
  | "30"
  | "60"
  | "120"
  | "240"
  | "360"
  | "720"
  | "D"
  | "W"
  | "M";

const INTERVAL_MS: Record<BybitInterval, number> = {
  "1": 60_000,
  "3": 3 * 60_000,
  "5": 5 * 60_000,
  "15": 15 * 60_000,
  "30": 30 * 60_000,
  "60": 60 * 60_000,
  "120": 2 * 60 * 60_000,
  "240": 4 * 60 * 60_000,
  "360": 6 * 60 * 60_000,
  "720": 12 * 60 * 60_000,
  D: 24 * 60 * 60_000,
  W: 7 * 24 * 60 * 60_000,
  M: 30 * 24 * 60 * 60_000,
};

export interface BybitHistoryOptions {
  category: BybitCategory;
  symbol: string;
  interval: BybitInterval;
  targetCount: number;
  signal?: AbortSignal;
}

interface RawBybitKlineResponse {
  retCode: number;
  result?: {
    category: string;
    symbol: string;
    list?: string[][];
  };
}

/** One row: [start, open, high, low, close, volume, turnover] in ms-string. */
function parseRow(row: string[], intervalMs: number): Candle {
  const start = parseInt(row[0]!, 10);
  return {
    openTime: start,
    open: parseFloat(row[1]!),
    high: parseFloat(row[2]!),
    low: parseFloat(row[3]!),
    close: parseFloat(row[4]!),
    volume: parseFloat(row[5]!),
    closeTime: start + intervalMs - 1,
    isFinal: true,
  };
}

export async function fetchBybitKlines({
  category,
  symbol,
  interval,
  targetCount,
  signal,
}: BybitHistoryOptions): Promise<Candle[]> {
  const intervalMs = INTERVAL_MS[interval];
  const pageSize = 1000;
  const seen = new Set<number>();
  const out: Candle[] = [];
  let endTime: number | undefined = undefined;

  for (let page = 0; page < 30 && out.length < targetCount; page++) {
    const url = new URL(BYBIT_KLINE_URL);
    url.searchParams.set("category", category);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(pageSize));
    if (endTime !== undefined) url.searchParams.set("end", String(endTime));

    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error(`Bybit kline fetch failed: ${res.status}`);
    const json: RawBybitKlineResponse = await res.json();
    if (json.retCode !== 0 || !json.result?.list) {
      throw new Error(
        `Bybit kline malformed: retCode=${json.retCode} category=${category}`,
      );
    }
    const rows = json.result.list;
    if (rows.length === 0) break;

    // Bybit returns newest-first; iterate and prepend non-dupes
    const fresh: Candle[] = [];
    for (const r of rows) {
      const c = parseRow(r, intervalMs);
      if (!seen.has(c.openTime)) {
        seen.add(c.openTime);
        fresh.push(c);
      }
    }
    if (fresh.length === 0) break;
    fresh.sort((a, b) => a.openTime - b.openTime);
    out.unshift(...fresh);

    const oldestOpen = fresh[0]!.openTime;
    endTime = oldestOpen - 1;

    if (rows.length < pageSize) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  out.sort((a, b) => a.openTime - b.openTime);
  return out.length > targetCount ? out.slice(-targetCount) : out;
}
