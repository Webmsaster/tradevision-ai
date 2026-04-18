/**
 * Sentiment Confluence Score.
 *
 * Combines the 4 independent cross-market sentiment signals into one
 * -100..+100 score:
 *   1. Coinbase Premium      (US retail spot flow)
 *   2. Bybit Basis           (perp-spot positioning)
 *   3. Long/Short Ratio mix  (retail leverage crowding)
 *   4. Deribit 25Δ Skew      (institutional option positioning)
 *
 * Each signal maps to a partial score in [-25, +25]. Total sum in
 * [-100, +100]. Magnitude reflects how many signals confirm vs dissent.
 *
 * High |score| = high-confidence regime read (tier-1 signal).
 * Near 0     = signals disagree (no conviction).
 */

import type { PremiumSnapshot } from "@/utils/coinbasePremium";
import type { BybitBasisSnapshot } from "@/utils/bybitBasis";
import type { DeribitSkewSnapshot } from "@/utils/deribitSkew";

export interface SentimentConfluence {
  score: number; // -100..+100
  bias: "strong-bullish" | "bullish" | "neutral" | "bearish" | "strong-bearish";
  confidence: "high" | "medium" | "low";
  components: {
    coinbasePremium: { score: number; note: string };
    bybitBasis: { score: number; note: string };
    deribitSkew: { score: number; note: string };
  };
  interpretation: string;
}

function scorePremium(p?: PremiumSnapshot): { score: number; note: string } {
  if (!p) return { score: 0, note: "n/a" };
  // ±0.3% maps to ±25
  const s = Math.max(-25, Math.min(25, (p.premiumPct / 0.003) * 25));
  return {
    score: s,
    note: `${(p.premiumPct * 100).toFixed(3)}% ${p.signal}`,
  };
}

function scoreBasis(b?: BybitBasisSnapshot): { score: number; note: string } {
  if (!b) return { score: 0, note: "n/a" };
  const s = Math.max(-25, Math.min(25, (b.basisPct / 0.003) * 25));
  return {
    score: s,
    note: `${(b.basisPct * 100).toFixed(3)}% ${b.signal}`,
  };
}

function scoreSkew(d?: DeribitSkewSnapshot): { score: number; note: string } {
  if (!d) return { score: 0, note: "n/a" };
  // ±5pp skew maps to ±25
  const s = Math.max(-25, Math.min(25, (d.skewPct / 0.05) * 25));
  return {
    score: s,
    note: `${(d.skewPct * 100).toFixed(2)}pp ${d.bias}`,
  };
}

export function computeSentimentConfluence(inputs: {
  coinbasePremium?: PremiumSnapshot;
  bybitBasis?: BybitBasisSnapshot;
  deribitSkew?: DeribitSkewSnapshot;
}): SentimentConfluence {
  const cbp = scorePremium(inputs.coinbasePremium);
  const byb = scoreBasis(inputs.bybitBasis);
  const drs = scoreSkew(inputs.deribitSkew);

  // Naive sum (3 components × 25 = 75 max; we scale up to 100 for readability)
  const raw = cbp.score + byb.score + drs.score;
  const score = Math.max(-100, Math.min(100, (raw / 75) * 100));

  // Confidence is high when signals agree, low when they dissent
  const signs = [cbp.score, byb.score, drs.score].filter((s) => s !== 0);
  const positives = signs.filter((s) => s > 0).length;
  const negatives = signs.filter((s) => s < 0).length;
  const agreement =
    signs.length > 0 ? Math.max(positives, negatives) / signs.length : 0;
  let confidence: SentimentConfluence["confidence"];
  if (agreement >= 0.8 && signs.length >= 2) confidence = "high";
  else if (agreement >= 0.6) confidence = "medium";
  else confidence = "low";

  let bias: SentimentConfluence["bias"];
  if (score > 50) bias = "strong-bullish";
  else if (score > 15) bias = "bullish";
  else if (score < -50) bias = "strong-bearish";
  else if (score < -15) bias = "bearish";
  else bias = "neutral";

  const interpretation = buildInterpretation(bias, confidence, signs.length);

  return {
    score,
    bias,
    confidence,
    components: {
      coinbasePremium: cbp,
      bybitBasis: byb,
      deribitSkew: drs,
    },
    interpretation,
  };
}

function buildInterpretation(
  bias: SentimentConfluence["bias"],
  confidence: SentimentConfluence["confidence"],
  nSignals: number,
): string {
  if (nSignals === 0) return "No sentiment data available";
  if (bias === "neutral") {
    return confidence === "high"
      ? "Signals agree on no directional bias — wait for conviction to return"
      : "Signals mixed or weak — no regime read";
  }
  const direction = bias.includes("bullish") ? "BULLISH" : "BEARISH";
  const strength = bias.startsWith("strong") ? "STRONG" : "moderate";
  if (confidence === "high") {
    return `${strength} ${direction} confluence — ${nSignals} signals aligned. High-conviction regime read.`;
  }
  if (confidence === "medium") {
    return `${strength} ${direction} lean — ${nSignals} signals mostly agree. Moderate conviction.`;
  }
  return `Signals disagree — net ${direction.toLowerCase()} lean but low confidence. Skip regime-gated trades.`;
}
