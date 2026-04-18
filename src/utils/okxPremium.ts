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

const OKX_BTC = "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT";
const BINANCE_BTC_SPOT =
  "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

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
  const [okxRes, bnbRes] = await Promise.all([
    fetch(OKX_BTC),
    fetch(BINANCE_BTC_SPOT),
  ]);
  if (!okxRes.ok) throw new Error(`OKX fetch failed: ${okxRes.status}`);
  if (!bnbRes.ok) throw new Error(`Binance fetch failed: ${bnbRes.status}`);
  const okxJson = (await okxRes.json()) as {
    code: string;
    data: { last: string }[];
  };
  const bnbJson = (await bnbRes.json()) as { price: string };
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
