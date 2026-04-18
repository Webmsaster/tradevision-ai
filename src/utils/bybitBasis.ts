/**
 * Bybit Basis Signal — BTC perp-vs-spot basis on Bybit.
 *
 * Different from Coinbase (fiat-premium) and OKX (USDT-arb): Bybit perp
 * trades alongside Bybit spot, both USDT-denominated. The basis is the
 * difference — when perp > spot by a lot, longs are paying a premium to
 * go long-levered. Used by quants as positioning indicator.
 *
 * Endpoints (free, no auth):
 *   Spot:    https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT
 *   Perp:    https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT
 *
 * Returns: { result: { list: [{ lastPrice, ... }] } }
 */

const BYBIT_URL = "https://api.bybit.com/v5/market/tickers";

export interface BybitBasisSnapshot {
  capturedAt: number;
  spotPriceUsdt: number;
  perpPriceUsdt: number;
  basisPct: number; // (perp - spot) / spot
  signal: "contango" | "backwardation" | "flat";
  magnitude: "extreme" | "strong" | "moderate" | "noise";
  interpretation: string;
}

async function fetchPrice(category: "spot" | "linear"): Promise<number> {
  const url = new URL(BYBIT_URL);
  url.searchParams.set("category", category);
  url.searchParams.set("symbol", "BTCUSDT");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Bybit ${category} fetch failed: ${res.status}`);
  const json = (await res.json()) as {
    retCode: number;
    result?: { list?: { lastPrice: string }[] };
  };
  if (json.retCode !== 0 || !json.result?.list?.[0]?.lastPrice) {
    throw new Error(`Bybit ${category} malformed response`);
  }
  return parseFloat(json.result.list[0].lastPrice);
}

export async function fetchBybitBasis(): Promise<BybitBasisSnapshot> {
  const [spot, perp] = await Promise.all([
    fetchPrice("spot"),
    fetchPrice("linear"),
  ]);
  const basis = spot > 0 ? (perp - spot) / spot : 0;
  const abs = Math.abs(basis);
  const magnitude: BybitBasisSnapshot["magnitude"] =
    abs > 0.003
      ? "extreme"
      : abs > 0.0015
        ? "strong"
        : abs > 0.0005
          ? "moderate"
          : "noise";
  const signal: BybitBasisSnapshot["signal"] =
    abs < 0.0005 ? "flat" : basis > 0 ? "contango" : "backwardation";

  let interpretation: string;
  if (signal === "flat") {
    interpretation = "Perp within 0.05% of spot — no structural tilt";
  } else if (signal === "contango") {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME contango (>0.3%) — levered longs crowded, short-squeeze risk"
        : magnitude === "strong"
          ? "Strong contango — longs paying premium to go levered"
          : "Mild contango — normal bull-market positioning";
  } else {
    interpretation =
      magnitude === "extreme"
        ? "EXTREME backwardation (>0.3%) — shorts crowded, potential short squeeze"
        : magnitude === "strong"
          ? "Strong backwardation — shorts paying premium, fear regime"
          : "Mild backwardation — bearish tilt";
  }

  return {
    capturedAt: Date.now(),
    spotPriceUsdt: spot,
    perpPriceUsdt: perp,
    basisPct: basis,
    signal,
    magnitude,
    interpretation,
  };
}
