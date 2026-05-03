/**
 * OKX–Binance Premium Signal.
 *
 * Mirror of the Coinbase Premium concept but for an Asian-retail flow.
 * OKX is the 2nd/3rd largest Asian spot exchange; persistent gap versus
 * Binance reveals where the Asian retail flow is landing.
 *
 * Endpoint: https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT
 * Returns JSON: {"code":"0","data":[{"last":"...","..."}]}
 *
 * We compare OKX BTC-USDT last to Binance BTCUSDT last.
 */

import type { Candle } from "@/utils/indicators";
import { fetchJsonWithRetry } from "@/utils/httpRetry";

const OKX_BTC = "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT";
const BINANCE_BTC_SPOT =
  "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const OKX_CANDLES = "https://www.okx.com/api/v5/market/candles";

export interface OkxPremiumSnapshot {
  capturedAt: number;
  okxPriceUsdt: number;
  binancePriceUsdt: number;
  premiumPct: number;
  signal: "bullish" | "bearish" | "neutral";
  magnitude: "extreme" | "strong" | "moderate" | "noise";
  interpretation: string;
}

export async function fetchOkxPremium(): Promise<OkxPremiumSnapshot> {
  // Round 56 (Fix 3): timeout + retry/backoff via shared helper.
  const [okxJson, bnbJson] = await Promise.all([
    fetchJsonWithRetry<{ code: string; data: { last: string }[] }>(OKX_BTC),
    fetchJsonWithRetry<{ price: string }>(BINANCE_BTC_SPOT),
  ]);
  if (okxJson.code !== "0" || !okxJson.data?.[0]) {
    throw new Error(`OKX response malformed`);
  }
  const okx = parseFloat(okxJson.data[0].last);
  const bnb = parseFloat(bnbJson.price);
  const premium = bnb > 0 ? (okx - bnb) / bnb : 0;
  const abs = Math.abs(premium);
  const magnitude: OkxPremiumSnapshot["magnitude"] =
    abs > 0.003
      ? "extreme"
      : abs > 0.0015
        ? "strong"
        : abs > 0.0005
          ? "moderate"
          : "noise";
  const signal: OkxPremiumSnapshot["signal"] =
    abs < 0.0005 ? "neutral" : premium > 0 ? "bullish" : "bearish";

  let interpretation: string;
  if (signal === "neutral") {
    interpretation = "OKX-Binance within 0.05% — no Asian-flow imbalance";
  } else if (signal === "bullish") {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME Asian buy pressure (>0.3%) — historical 12-24h continuation"
        : magnitude === "strong"
          ? "Strong Asian buying (>0.15%)"
          : "Mild Asian-buyer tilt";
  } else {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME Asian sell pressure (>0.3%) — pre-dump warning"
        : magnitude === "strong"
          ? "Strong Asian selling (>0.15%)"
          : "Mild Asian-seller tilt";
  }

  return {
    capturedAt: Date.now(),
    okxPriceUsdt: okx,
    binancePriceUsdt: bnb,
    premiumPct: premium,
    signal,
    magnitude,
    interpretation,
  };
}

/**
 * OKX /api/v5/market/candles raw candle row:
 *   [ts, open, high, low, close, volume, volCcyQuote, volCcy, confirm]
 * Returns newest-first. We use `after` param to paginate backwards (fetch
 * older candles before the given timestamp).
 *
 * Max 100 rows per call. For 5000 bars we need 50 pages.
 */
type RawOkxCandle = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export async function fetchOkxCandles(
  instId: string,
  bar: "1H" | "4H" | "1D" = "1H",
  limit = 100,
  after?: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const url = new URL(OKX_CANDLES);
  url.searchParams.set("instId", instId);
  url.searchParams.set("bar", bar);
  url.searchParams.set("limit", String(Math.min(limit, 100)));
  if (after !== undefined) url.searchParams.set("after", String(after));
  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`OKX candles fetch failed: ${res.status}`);
  const json = (await res.json()) as { code: string; data: RawOkxCandle[] };
  if (json.code !== "0") throw new Error(`OKX error code ${json.code}`);
  const barMs =
    bar === "1H"
      ? 60 * 60 * 1000
      : bar === "4H"
        ? 4 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  return json.data
    .map((r) => ({
      openTime: parseInt(r[0]),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      closeTime: parseInt(r[0]) + barMs - 1,
      isFinal: r[8] === "1",
    }))
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Page backwards through OKX to assemble up to `targetBars`. Respects
 * rate-limit (250ms between calls).
 */
export async function fetchOkxLongHistory(
  instId: string,
  bar: "1H" | "4H" | "1D",
  targetBars: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  const seen = new Set<number>();
  let after: number | undefined;
  const maxPages = Math.ceil(targetBars / 100) + 5;
  for (let page = 0; page < maxPages && all.length < targetBars; page++) {
    let batch: Candle[];
    try {
      batch = await fetchOkxCandles(instId, bar, 100, after);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        batch = await fetchOkxCandles(instId, bar, 100, after);
      } catch {
        break;
      }
    }
    if (batch.length === 0) break;
    let freshAdded = 0;
    for (const c of batch) {
      if (!seen.has(c.openTime)) {
        seen.add(c.openTime);
        all.push(c);
        freshAdded++;
      }
    }
    if (freshAdded === 0) break;
    after = batch[0]!.openTime; // oldest → pagination backwards
    await new Promise((r) => setTimeout(r, 250));
  }
  return all.sort((a, b) => a.openTime - b.openTime);
}
