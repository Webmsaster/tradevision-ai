/**
 * Coinbase Premium Signal.
 *
 * Research basis: same mechanism as the well-documented Korean Premium
 * (Kim/Kwon 2023, PLoS ONE; Choi et al. 2022, Journal of Financial
 * Markets). Large, persistent price divergence between a regional spot
 * exchange and the global (Binance) benchmark signals one-sided flow:
 *
 *   - Coinbase > Binance by >0.1% : US retail/institutional buying aggressively
 *     → historically bullish for next 24-48h on BTC
 *   - Coinbase < Binance by >0.1% : US selling, often pre-dump
 *     → bearish signal
 *   - Flat (|premium| < 0.05%) : no informational edge
 *
 * Why not arbitraged: KYC-walled fiat rails between exchanges create
 * structural friction (days to move USD from Coinbase to Binance in size).
 *
 * Live-only: Coinbase historical 1h bars require Coinbase Advanced API
 * auth. Public ticker is free and sufficient for live detection.
 */

const COINBASE_BTC_SPOT =
  "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
const BINANCE_BTC_SPOT =
  "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

export interface PremiumSnapshot {
  capturedAt: number;
  coinbasePriceUsd: number;
  binancePriceUsd: number;
  premiumPct: number; // (cb - bnb) / bnb
  signal: "bullish" | "bearish" | "neutral";
  magnitude: "extreme" | "strong" | "moderate" | "noise";
  interpretation: string;
}

export async function fetchCoinbasePremium(): Promise<PremiumSnapshot> {
  const [cbRes, bnbRes] = await Promise.all([
    fetch(COINBASE_BTC_SPOT),
    fetch(BINANCE_BTC_SPOT),
  ]);
  if (!cbRes.ok) throw new Error(`Coinbase fetch failed: ${cbRes.status}`);
  if (!bnbRes.ok) throw new Error(`Binance fetch failed: ${bnbRes.status}`);
  const cbJson = (await cbRes.json()) as { price: string };
  const bnbJson = (await bnbRes.json()) as { price: string };
  const cb = parseFloat(cbJson.price);
  const bnb = parseFloat(bnbJson.price);
  const premium = bnb > 0 ? (cb - bnb) / bnb : 0;
  const abs = Math.abs(premium);
  const magnitude: PremiumSnapshot["magnitude"] =
    abs > 0.003
      ? "extreme"
      : abs > 0.0015
        ? "strong"
        : abs > 0.0005
          ? "moderate"
          : "noise";
  const signal: PremiumSnapshot["signal"] =
    abs < 0.0005 ? "neutral" : premium > 0 ? "bullish" : "bearish";

  let interpretation: string;
  if (signal === "neutral") {
    interpretation =
      "Coinbase and Binance prices within 0.05% — no flow imbalance";
  } else if (signal === "bullish") {
    if (magnitude === "extreme") {
      interpretation =
        "EXTREME US buy pressure (>0.3% premium) — historically strong 24-48h continuation";
    } else if (magnitude === "strong") {
      interpretation =
        "Strong US buying (>0.15% premium) — bullish bias next 12-24h";
    } else {
      interpretation = "Mild US-buyer tilt — weak bullish signal";
    }
  } else {
    if (magnitude === "extreme") {
      interpretation =
        "EXTREME US sell pressure (>0.3% discount) — historically pre-dump warning";
    } else if (magnitude === "strong") {
      interpretation =
        "Strong US selling (>0.15% discount) — bearish bias next 12-24h";
    } else {
      interpretation = "Mild US-seller tilt — weak bearish signal";
    }
  }

  return {
    capturedAt: Date.now(),
    coinbasePriceUsd: cb,
    binancePriceUsd: bnb,
    premiumPct: premium,
    signal,
    magnitude,
    interpretation,
  };
}
