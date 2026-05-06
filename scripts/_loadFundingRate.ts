/**
 * Loads historical funding rates from Binance Futures.
 * Public endpoint, no API key needed. Funding settles every 8h.
 */
interface BinanceFundingRow {
  fundingTime: number;
  fundingRate: string;
  symbol: string;
}

export interface FundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: number;
}

export async function loadBinanceFundingRate(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<FundingRow[]> {
  const out: FundingRow[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMs));
    url.searchParams.set("limit", "1000");
    const res = await fetch(url.toString());
    if (!res.ok) {
      // Some symbols may not have futures pairs; return empty array
      if (res.status === 400) return out;
      throw new Error(`Funding fetch failed: ${res.status} for ${symbol}`);
    }
    const rows = (await res.json()) as BinanceFundingRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({
        symbol,
        fundingTime: r.fundingTime,
        fundingRate: parseFloat(r.fundingRate),
      });
    }
    const lastTs = rows[rows.length - 1].fundingTime;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    if (rows.length < 1000) break;
  }
  return out.sort((a, b) => a.fundingTime - b.fundingTime);
}

/**
 * Forward-fill funding rate to candle timestamps.
 * For each candle, use the most recent funding rate that is ≤ candle.openTime.
 */
export function alignFundingToCandles(
  funding: FundingRow[],
  candleTimes: number[],
): (number | null)[] {
  const out: (number | null)[] = new Array(candleTimes.length).fill(null);
  let fIdx = 0;
  let lastRate: number | null = null;
  for (let i = 0; i < candleTimes.length; i++) {
    const t = candleTimes[i];
    while (fIdx < funding.length && funding[fIdx].fundingTime <= t) {
      lastRate = funding[fIdx].fundingRate;
      fIdx++;
    }
    out[i] = lastRate;
  }
  return out;
}
