/**
 * Yahoo Finance historical data loader.
 *
 * Used for off-Binance data sources (forex, indices, dollar index)
 * to cross-correlate with crypto signals. No API key required.
 *
 * Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 * Ticker examples:
 *   - EURUSD=X   (euro/dollar)
 *   - GBPUSD=X
 *   - USDJPY=X
 *   - DX-Y.NYB   (US Dollar Index)
 *   - ^GSPC      (S&P 500)
 *   - ^IXIC      (NASDAQ Composite)
 *   - ^NDX       (NASDAQ-100)
 *   - ^GDAXI     (DAX)
 *   - ETH-USD    (Ethereum via Yahoo)
 *
 * Interval limits:
 *   - 60m (1h): up to 730 days
 *   - 1d:       unlimited
 *   - 1wk/1mo:  unlimited
 */
import type { Candle } from "@/utils/indicators";

export type YahooInterval = "60m" | "1d" | "1wk";

export interface YahooLoadOptions {
  symbol: string;
  interval: YahooInterval;
  /** Days of history to request, counting back from now. */
  days: number;
  signal?: AbortSignal;
}

interface YahooChartResponse {
  chart: {
    result: Array<{
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

/**
 * Load historical OHLCV candles from Yahoo Finance.
 *
 * The Yahoo chart endpoint returns parallel arrays for timestamps and
 * OHLCV. We zip them into Candle[]. Rows with null fields (mid-session
 * gaps, weekends for forex, etc.) are skipped.
 */
export async function loadYahooHistory({
  symbol,
  interval,
  days,
  signal,
}: YahooLoadOptions): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const period1 = now - days * 24 * 3600;
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  url.searchParams.set("period1", String(period1));
  url.searchParams.set("period2", String(now));
  url.searchParams.set("interval", interval);

  const res = await fetch(url.toString(), {
    signal,
    headers: {
      // Yahoo occasionally rejects requests without a UA.
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo fetch ${res.status} ${res.statusText}`);
  const body = (await res.json()) as YahooChartResponse;
  if (body.chart.error) throw new Error(body.chart.error.description);
  const result = body.chart.result?.[0];
  if (!result) return [];

  const { timestamp } = result;
  const q = result.indicators.quote[0];
  const out: Candle[] = [];
  const barSeconds =
    interval === "60m" ? 3600 : interval === "1d" ? 86400 : 604800;

  for (let i = 0; i < timestamp.length; i++) {
    const o = q.open[i],
      h = q.high[i],
      l = q.low[i],
      c = q.close[i],
      v = q.volume[i];
    if (o === null || h === null || l === null || c === null) continue;
    const openTime = timestamp[i] * 1000;
    out.push({
      openTime,
      closeTime: openTime + barSeconds * 1000 - 1,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
      isFinal: true,
    });
  }
  return out;
}

/**
 * Aggregate 1h Yahoo candles to 4h by grouping consecutive bars.
 * Groups of 4 consecutive 1h candles → one 4h candle (OHLC).
 * Partial groups at the tail are dropped.
 */
export function aggregateTo4h(candles1h: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 4 <= candles1h.length; i += 4) {
    const group = candles1h.slice(i, i + 4);
    const first = group[0];
    const last = group[3];
    let high = -Infinity,
      low = Infinity,
      volume = 0;
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    out.push({
      openTime: first.openTime,
      closeTime: last.closeTime,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      isFinal: true,
    });
  }
  return out;
}
