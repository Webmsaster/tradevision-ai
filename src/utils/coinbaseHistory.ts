/**
 * Coinbase Exchange historical candle fetcher.
 *
 * Endpoint: https://api.exchange.coinbase.com/products/{product}/candles
 *   - Free, no auth
 *   - granularity (seconds): 60, 300, 900, 3600, 21600, 86400
 *   - max 300 rows per call
 *   - 1h granularity = 3600 → ~12.5 days per call
 *
 * Used to backtest the Coinbase-Binance Premium signal.
 */

import type { Candle } from "@/utils/indicators";

export interface CoinbaseHistoryOptions {
  product: string; // e.g. "BTC-USD"
  granularity: 60 | 300 | 900 | 3600 | 21600 | 86400;
  start?: Date;
  end?: Date;
  signal?: AbortSignal;
}

/** One row: [time, low, high, open, close, volume] in seconds. */
type RawCbCandle = [number, number, number, number, number, number];

export async function fetchCoinbaseCandles(
  options: CoinbaseHistoryOptions,
): Promise<Candle[]> {
  const url = new URL(
    `https://api.exchange.coinbase.com/products/${options.product}/candles`,
  );
  url.searchParams.set("granularity", String(options.granularity));
  if (options.start) url.searchParams.set("start", options.start.toISOString());
  if (options.end) url.searchParams.set("end", options.end.toISOString());
  const res = await fetch(url.toString(), { signal: options.signal });
  if (!res.ok) throw new Error(`Coinbase candles fetch failed: ${res.status}`);
  const rows: RawCbCandle[] = await res.json();
  // Coinbase returns newest-first; sort ascending and map to Candle schema
  return rows
    .map((r) => ({
      openTime: r[0] * 1000,
      open: r[3],
      high: r[2],
      low: r[1],
      close: r[4],
      volume: r[5],
      closeTime: r[0] * 1000 + options.granularity * 1000 - 1,
      isFinal: true,
    }))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Page backwards through Coinbase's 300-row-per-call limit to assemble a
 * longer window. Respects rate-limit with a small delay.
 */
export async function fetchCoinbaseLongHistory(
  product: string,
  granularity: 3600 | 86400,
  targetBars: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let end = new Date();
  // Cap pages high enough to reach ~5000+ bars at 300/page.
  const maxPages = Math.ceil(targetBars / 300) + 5;
  for (let page = 0; page < maxPages && all.length < targetBars; page++) {
    const start = new Date(end.getTime() - 300 * granularity * 1000);
    let batch: Candle[];
    try {
      batch = await fetchCoinbaseCandles({
        product,
        granularity,
        start,
        end,
      });
    } catch {
      // Rate-limited? Back off and retry once, then give up
      await new Promise((r) => setTimeout(r, 2000));
      try {
        batch = await fetchCoinbaseCandles({
          product,
          granularity,
          start,
          end,
        });
      } catch {
        break;
      }
    }
    if (batch.length === 0) break;
    all.unshift(...batch);
    end = new Date(batch[0].openTime - 1);
    // Be kind: 350ms between calls for longer walks
    await new Promise((r) => setTimeout(r, 350));
  }
  // Dedupe (Coinbase may overlap between pages)
  const seen = new Set<number>();
  const uniq: Candle[] = [];
  for (const c of all) {
    if (!seen.has(c.openTime)) {
      seen.add(c.openTime);
      uniq.push(c);
    }
  }
  return uniq.sort((a, b) => a.openTime - b.openTime);
}
