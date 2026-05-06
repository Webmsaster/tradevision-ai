/**
 * Yahoo Finance + Stooq historical data loader.
 *
 * Two endpoints:
 *   loadYahooDaily(symbol)           — Stooq daily CSV (no auth, deep history)
 *   loadYahooIntraday(symbol, tf)    — Yahoo v8 chart API (1h max ~730 days)
 *
 * Index symbols (Yahoo format, must be URL-encoded with `%5E` for `^`):
 *   ^GSPC (S&P 500), ^DJI (Dow), ^IXIC (Nasdaq), ^GDAXI (DAX), ^FTSE (FTSE 100)
 */
import type { Candle } from "../src/utils/indicators";

type YahooKline = number | null;
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: YahooKline[];
          high?: YahooKline[];
          low?: YahooKline[];
          close?: YahooKline[];
          volume?: YahooKline[];
        }>;
      };
    }>;
  };
}

interface YahooArgs {
  symbol: string;
  startMs?: number;
  endMs?: number;
}

export async function loadYahooDaily({ symbol }: YahooArgs): Promise<Candle[]> {
  // Stooq endpoint: free CSV, no auth. URL: https://stooq.com/q/d/l/?s=eurusd&i=d
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`Stooq fetch ${res.status} for ${symbol}`);
  const csv = await res.text();
  if (csv.includes("No data")) throw new Error(`Stooq: no data for ${symbol}`);
  const lines = csv.split("\n").slice(1);
  const out: Candle[] = [];
  for (const ln of lines) {
    const parts = ln.split(",");
    if (parts.length < 5) continue;
    const [date, o, h, l, c, v] = parts;
    if (!date || !o || o === "null") continue;
    const ts = new Date(date).getTime();
    if (!Number.isFinite(ts)) continue;
    out.push({
      openTime: ts,
      closeTime: ts + 24 * 3600_000,
      open: parseFloat(o),
      high: parseFloat(h),
      low: parseFloat(l),
      close: parseFloat(c),
      volume: parseFloat(v) || 1_000_000,
      isFinal: true,
    });
  }
  return out;
}

/**
 * Yahoo Finance v8 chart API — intraday OHLC.
 * Supports interval: 1m, 2m, 5m, 15m, 30m, 60m / 1h, 1d, 1wk, 1mo
 * Range max for 1h: ~730 days. Range max for 1d: 10y+.
 *
 * @param symbol Yahoo ticker (e.g. "^GSPC", "^DJI") — will be URL-encoded
 * @param interval "1h" | "60m" | "30m" | "1d" etc.
 * @param range    "2y" | "1y" | "60d" | "max"
 */
export async function loadYahooIntraday(
  symbol: string,
  interval: string,
  range: string,
): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  // Phase 5 (Forex Bug 1): 429/503 retry with exponential backoff +
  // retry-after honor. Yahoo throttles aggressively when 6 forex symbols
  // load in parallel — single fetch failed silent.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 429 && res.status !== 503) break;
    const ra = res.headers.get("retry-after");
    const wait = Math.min(
      ra ? parseInt(ra, 10) * 1000 : 1500 * 2 ** attempt,
      60_000,
    );
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res || !res.ok) {
    throw new Error(
      `Yahoo intraday ${res?.status ?? "?"} for ${symbol} ${interval}/${range}`,
    );
  }
  const json = (await res.json()) as YahooChartResponse;
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no result for ${symbol}`);
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q || !ts.length) throw new Error(`Yahoo: empty quote for ${symbol}`);
  const open: (number | null)[] = q.open ?? [];
  const high: (number | null)[] = q.high ?? [];
  const low: (number | null)[] = q.low ?? [];
  const close: (number | null)[] = q.close ?? [];
  const volume: (number | null)[] = q.volume ?? [];
  const out: Candle[] = [];
  // Determine bar duration in ms from interval
  const intervalMs = parseIntervalMs(interval);
  for (let i = 0; i < ts.length; i++) {
    const o = open[i],
      h = high[i],
      l = low[i],
      c = close[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      openTime: ts[i] * 1000,
      closeTime: ts[i] * 1000 + intervalMs,
      open: o,
      high: h,
      low: l,
      close: c,
      // Phase 5 (Forex Bug 9): forex feed gives volume=0 (not null);
      // engine indicators that use volume-weight need a positive default.
      volume: volume[i] && volume[i]! > 0 ? volume[i]! : 1_000_000,
      isFinal: true,
    });
  }
  return out;
}

function parseIntervalMs(s: string): number {
  // Phase 5 (Forex Bug 12): "1mo"/"3mo" matched .endsWith("m") and returned
  // 60_000ms (1 minute). Check longer suffixes first.
  if (s === "1mo" || s === "3mo") return parseInt(s) * 30 * 24 * 3600_000;
  if (s.endsWith("wk")) return parseInt(s) * 7 * 24 * 3600_000;
  if (s.endsWith("h")) return parseInt(s) * 3600_000;
  if (s.endsWith("d")) return parseInt(s) * 24 * 3600_000;
  if (s.endsWith("m")) return parseInt(s) * 60_000;
  return 60_000;
}

/**
 * Resample a sequence of candles to a coarser timeframe.
 * Bars are bucketed by `Math.floor(openTime / targetMs) * targetMs`.
 * Open = first bar's open, close = last bar's close, high = max, low = min.
 *
 * Phase 43 (R44-MD-2): drop incomplete leading bucket where the source
 * bars don't cover the full target period. Without this, the first
 * resampled bar reported open=src[0].open (e.g. 13:00 open) but
 * openTime=12:00 (bucket boundary) — inconsistent with downstream
 * indicators that assume `closeTime - openTime = targetMs` of real data.
 */
export function resampleCandles(src: Candle[], targetMs: number): Candle[] {
  if (src.length === 0) return [];
  const sorted = [...src].sort((a, b) => a.openTime - b.openTime);
  // Infer source bar duration from the most common spacing (defensive
  // against gaps); falls back to first-pair if length < 3.
  const srcMs =
    sorted.length >= 2 ? sorted[1].openTime - sorted[0].openTime : targetMs;
  const expectedBarsPerBucket = srcMs > 0 ? Math.round(targetMs / srcMs) : 1;

  const buckets = new Map<number, Candle[]>();
  for (const c of sorted) {
    const k = Math.floor(c.openTime / targetMs) * targetMs;
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(c);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const arr = buckets.get(k)!;
    // Phase R57 (Round 57 Forex Fix 1): drop ANY under-filled bucket.
    // Previous logic only dropped the leading bucket (i===0), but
    // mid-series under-filled buckets occur during forex weekend reopen
    // (Sun 22:00 UTC) and holidays — emitting them as "valid" 2h/4h
    // bars with only 1h of data distorts ATR/percentile calculations.
    // Trailing partials are dropped too; callers needing partial
    // current-bar data should consume source candles directly.
    if (expectedBarsPerBucket > 1 && arr.length < expectedBarsPerBucket) {
      continue;
    }
    const first = arr[0];
    const last = arr[arr.length - 1];
    out.push({
      openTime: k,
      closeTime: k + targetMs,
      open: first.open,
      high: Math.max(...arr.map((c) => c.high)),
      low: Math.min(...arr.map((c) => c.low)),
      close: last.close,
      volume: arr.reduce((s, c) => s + c.volume, 0),
      isFinal: true,
    });
  }
  return out;
}
