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
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
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
  // BUGFIX 2026-04-28: was hardcoded isFinal=true → live polling within seconds
  // of a bar close could include the still-forming next bar (closeTime > now)
  // → phantom signals on incomplete data. Now: closed only if closeTime <= now.
  const closeTime = row[6];
  // Phase 33 (Indicators Audit Bug 4): NaN-validation. A single corrupt
  // Binance row (rare but happens during maintenance windows) was
  // permanently poisoning RSI/ATR for thousands of bars after — Wilder
  // smoothing has no NaN-recovery.
  const open = parseFloat(row[1]);
  const high = parseFloat(row[2]);
  const low = parseFloat(row[3]);
  const close = parseFloat(row[4]);
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    throw new Error(
      `Corrupt Binance kline at openTime ${row[0]}: open=${row[1]} high=${row[2]} low=${row[3]} close=${row[4]}`,
    );
  }
  return {
    openTime: row[0],
    open,
    high,
    low,
    close,
    volume: parseFloat(row[5]) || 0,
    closeTime,
    isFinal: closeTime < Date.now(),
    // Binance kline schema index 9 = takerBuyBaseAssetVolume
    takerBuyVolume: parseFloat(row[9]) || 0,
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
  // Phase 70 (R45-API-7): hard total-budget across ALL pages + retries.
  // Per-fetch already had AbortSignal.timeout(15s) but with 30 pages × up
  // to 3 retries × up to 60s retry-after wait, the worst-case total
  // could exceed Vercel's function timeout. 90s upper bound here keeps
  // a single loadBinanceHistory call from dragging the whole route down.
  const TOTAL_BUDGET_MS = 90_000;
  const startedAt = Date.now();

  // Hard cap on iterations as a safety net
  for (let page = 0; page < cap && candles.length < targetCount; page++) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      console.warn(
        `[loadBinanceHistory] total-budget exceeded (${TOTAL_BUDGET_MS}ms) — returning ${candles.length} of ${targetCount} target candles`,
      );
      break;
    }
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", timeframe);
    url.searchParams.set("limit", String(pageSize));
    if (endTime !== undefined) url.searchParams.set("endTime", String(endTime));

    // BUGFIX 2026-04-28: add 15s timeout so a hanging Binance call doesn't
    // freeze the entire Live signal loop indefinitely.
    const timeoutSig = AbortSignal.timeout(15_000);
    const finalSignal = signal
      ? AbortSignal.any([signal, timeoutSig])
      : timeoutSig;
    let res = await fetch(url.toString(), { signal: finalSignal });
    // Retry on 429/418 (rate-limit) and 5xx (Binance maintenance) with
    // exponential backoff. Binance typically clears in 1-3s; we try thrice.
    // Phase 33 (Indicators Audit Bug 5+15): respect caller AbortSignal during
    // backoff sleep AND on the retry fetch. Was using only AbortSignal.timeout
    // → caller cancel was ignored during retry-after waits up to 60s.
    let retry = 0;
    const isRetryable = (s: number) =>
      s === 429 || s === 418 || (s >= 500 && s < 600);
    while (isRetryable(res.status) && retry < 3) {
      const retryAfterHdr = res.headers.get("retry-after");
      const wait = Math.min(
        retryAfterHdr ? parseInt(retryAfterHdr, 10) * 1000 : 2000 * (retry + 1),
        60_000,
      );
      await new Promise<void>((r, reject) => {
        const t = setTimeout(r, wait);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const retrySignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      res = await fetch(url.toString(), { signal: retrySignal });
      retry++;
    }
    if (!res.ok) throw new Error(`Binance history fetch failed: ${res.status}`);
    // R67-r3 (2026-05-06): some upstream proxies / Cloudflare maintenance
    // pages return HTTP 200 with text/html. `res.json()` on those throws an
    // un-helpful SyntaxError that hid the real cause. Verify content-type
    // first and surface a retryable error with a body snippet for diagnostics.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Binance history non-JSON response (content-type=${ct || "<none>"}, status=${res.status}): ${body.slice(0, 200)}`,
      );
    }
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
    const oldestOpen = batch[0]!.openTime;
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
