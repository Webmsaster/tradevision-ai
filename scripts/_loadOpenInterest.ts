/**
 * Loads Binance Futures Open Interest history (5-minute granularity available
 * via openInterestHist endpoint). Public, no API key.
 */
interface BinanceOiRow {
  timestamp: number;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
}

export interface OIRow {
  timestamp: number;
  oi: number;
  oiQuote: number;
}

/**
 * Note: Binance's openInterestHist only returns 30 days of 5m data per request.
 * We page backwards in time. The endpoint requires `period` (5m, 15m, 30m, 1h, 4h, 1d).
 */
export async function loadBinanceOpenInterest(
  symbol: string,
  period: "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d",
  startMs: number,
  endMs: number,
): Promise<OIRow[]> {
  const out: OIRow[] = [];
  let cursor = endMs;
  while (cursor > startMs) {
    const url = new URL(
      "https://fapi.binance.com/futures/data/openInterestHist",
    );
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("period", period);
    url.searchParams.set("endTime", String(cursor));
    url.searchParams.set("limit", "500");
    let res = await fetch(url.toString());
    if (res.status === 429) {
      const retryAfter =
        parseInt(res.headers.get("retry-after") ?? "5", 10) * 1000;
      await new Promise((r) => setTimeout(r, retryAfter));
      res = await fetch(url.toString());
    }
    if (!res.ok) {
      if (res.status === 400) return out;
      throw new Error(`OI fetch failed: ${res.status} for ${symbol}`);
    }
    const rows = (await res.json()) as BinanceOiRow[];
    if (!rows || rows.length === 0) break;
    // Phase 43 (R44-MD-1): sort response ascending before reading rows[0].
    // Binance openInterestHist response order isn't documented to be stable
    // across versions — explicit sort guarantees rows[0]=oldest regardless.
    rows.sort((a, b) => a.timestamp - b.timestamp);
    for (const r of rows) {
      if (r.timestamp < startMs || r.timestamp > endMs) continue;
      out.push({
        timestamp: r.timestamp,
        oi: parseFloat(r.sumOpenInterest),
        oiQuote: parseFloat(r.sumOpenInterestValue),
      });
    }
    const oldest = rows[0].timestamp;
    if (oldest >= cursor) break;
    cursor = oldest - 1;
    if (rows.length < 500) break;
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/** Forward-fill OI to candle timestamps. */
export function alignOIToCandles(
  oi: OIRow[],
  candleTimes: number[],
): (number | null)[] {
  const out: (number | null)[] = new Array(candleTimes.length).fill(null);
  let oIdx = 0;
  let last: number | null = null;
  for (let i = 0; i < candleTimes.length; i++) {
    while (oIdx < oi.length && oi[oIdx].timestamp <= candleTimes[i]) {
      last = oi[oIdx].oi;
      oIdx++;
    }
    out[i] = last;
  }
  return out;
}
