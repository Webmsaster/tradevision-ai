/**
 * sentimentConfluence tests.
 *
 * Pure-function module: computeSentimentConfluence combines up to 3
 * sentiment snapshots (Coinbase premium, Bybit basis, Deribit skew) into
 * a -100..+100 score + bias/confidence/interpretation.
 *
 * Covers: missing inputs (n/a components), per-component scaling +
 * clamping at ±25, score normalisation to ±100, all bias buckets,
 * confidence tiers (high agreement / medium / dissent), and every
 * interpretation branch.
 */
import { describe, expect, it } from "vitest";
import { computeSentimentConfluence } from "@/utils/sentimentConfluence";
import type { PremiumSnapshot } from "@/utils/coinbasePremium";
import type { BybitBasisSnapshot } from "@/utils/bybitBasis";
import type { DeribitSkewSnapshot } from "@/utils/deribitSkew";

function premium(premiumPct: number): PremiumSnapshot {
  return {
    capturedAt: 0,
    coinbasePriceUsd: 100_000,
    binancePriceUsd: 100_000,
    premiumPct,
    signal: premiumPct > 0 ? "bullish" : premiumPct < 0 ? "bearish" : "neutral",
    magnitude: "moderate",
    interpretation: "",
  };
}

function basis(basisPct: number): BybitBasisSnapshot {
  return {
    capturedAt: 0,
    spotPriceUsdt: 100_000,
    perpPriceUsdt: 100_000,
    basisPct,
    signal: basisPct > 0 ? "contango" : basisPct < 0 ? "backwardation" : "flat",
    magnitude: "moderate",
    interpretation: "",
  };
}

function skew(skewPct: number): DeribitSkewSnapshot {
  return {
    capturedAt: 0,
    expiry: "26APR26",
    spotEstimate: 100_000,
    call25dIv: 0.5,
    put25dIv: 0.5,
    skewPct,
    bias: skewPct > 0 ? "bullish" : skewPct < 0 ? "bearish" : "neutral",
    magnitude: "moderate",
    interpretation: "",
  };
}

describe("computeSentimentConfluence — no data", () => {
  it("returns neutral/low with 'No sentiment data available' when all inputs missing", () => {
    const result = computeSentimentConfluence({});
    expect(result.score).toBe(0);
    expect(result.bias).toBe("neutral");
    expect(result.confidence).toBe("low");
    expect(result.interpretation).toBe("No sentiment data available");
    expect(result.components.coinbasePremium).toEqual({
      score: 0,
      note: "n/a",
    });
    expect(result.components.bybitBasis).toEqual({ score: 0, note: "n/a" });
    expect(result.components.deribitSkew).toEqual({ score: 0, note: "n/a" });
  });
});

describe("computeSentimentConfluence — component scaling", () => {
  it("maps premium ±0.3% and skew ±5pp to the full ±25 component score", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.003),
      deribitSkew: skew(-0.05),
    });
    expect(r.components.coinbasePremium.score).toBeCloseTo(25, 6);
    expect(r.components.deribitSkew.score).toBeCloseTo(-25, 6);
  });

  it("clamps oversized component inputs at ±25", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.05), // 16× the saturation point
      bybitBasis: basis(-0.09),
    });
    expect(r.components.coinbasePremium.score).toBe(25);
    expect(r.components.bybitBasis.score).toBe(-25);
  });

  it("formats component notes with pct value and signal label", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.0015),
      bybitBasis: basis(0.0012),
      deribitSkew: skew(0.02),
    });
    expect(r.components.coinbasePremium.note).toBe("0.150% bullish");
    expect(r.components.bybitBasis.note).toBe("0.120% contango");
    expect(r.components.deribitSkew.note).toBe("2.00pp bullish");
  });
});

describe("computeSentimentConfluence — bias + confidence buckets", () => {
  it("all 3 saturated bullish → score 100, strong-bullish, high confidence", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.003),
      bybitBasis: basis(0.003),
      deribitSkew: skew(0.05),
    });
    expect(r.score).toBeCloseTo(100, 6);
    expect(r.bias).toBe("strong-bullish");
    expect(r.confidence).toBe("high");
    expect(r.interpretation).toContain("STRONG BULLISH confluence");
    expect(r.interpretation).toContain("3 signals aligned");
  });

  it("all 3 saturated bearish → score -100, strong-bearish, high confidence", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(-0.003),
      bybitBasis: basis(-0.003),
      deribitSkew: skew(-0.05),
    });
    expect(r.score).toBeCloseTo(-100, 6);
    expect(r.bias).toBe("strong-bearish");
    expect(r.confidence).toBe("high");
    expect(r.interpretation).toContain("STRONG BEARISH confluence");
  });

  it("two mildly-positive signals → bullish, agreeing but weak", () => {
    // Each component: 0.0009/0.003*25 = 7.5 → raw 15 → score 20 (>15 bullish)
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.0009),
      bybitBasis: basis(0.0009),
    });
    expect(r.score).toBeCloseTo(20, 6);
    expect(r.bias).toBe("bullish");
    expect(r.confidence).toBe("high"); // 2/2 agreement
    expect(r.interpretation).toContain("moderate BULLISH confluence");
  });

  it("moderate bearish lean with 2/3 agreement → bearish, medium confidence", () => {
    // -25 + -25 + +12.5 = raw -37.5 → score -50 → bearish (not strong);
    // agreement 2/3 ≈ 0.67 → medium.
    const r = computeSentimentConfluence({
      coinbasePremium: premium(-0.003),
      bybitBasis: basis(-0.003),
      deribitSkew: skew(0.025),
    });
    expect(r.score).toBeCloseTo(-50, 6);
    expect(r.bias).toBe("bearish");
    expect(r.confidence).toBe("medium");
    expect(r.interpretation).toContain("BEARISH lean");
    expect(r.interpretation).toContain("Moderate conviction");
  });

  it("agreeing-but-flat signals → neutral with high confidence message", () => {
    // Two tiny positives: 2 × ~3.33 = raw 6.67 → score ~8.9 (≤15 neutral),
    // agreement 1.0 with 2 signals → high confidence neutral branch.
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.0004),
      bybitBasis: basis(0.0004),
    });
    expect(r.bias).toBe("neutral");
    expect(r.confidence).toBe("high");
    expect(r.interpretation).toContain("Signals agree on no directional bias");
  });

  it("perfectly dissenting signals → neutral, low confidence, mixed message", () => {
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.003),
      bybitBasis: basis(-0.003),
    });
    expect(r.score).toBeCloseTo(0, 6);
    expect(r.bias).toBe("neutral");
    expect(r.confidence).toBe("low"); // 1/2 agreement < 0.6
    expect(r.interpretation).toContain("Signals mixed or weak");
  });

  it("strong lean with dissent → low confidence 'skip regime-gated trades'", () => {
    // +25 +25 -25 → raw 25 → score 33.3 → bullish; agreement 2/3 wait —
    // 0.67 ≥ 0.6 is medium. Force low: 1 positive vs 1 negative with net
    // bullish via clamping asymmetry is impossible at 2 signals, so use
    // 3 signals: +25, -25, +5 → raw +5 → neutral. Instead exercise the
    // low-confidence directional branch with 2 signals: +25 and -7.5
    // → raw 17.5 → score 23.3 (bullish), agreement 1/2 = 0.5 → low.
    const r = computeSentimentConfluence({
      coinbasePremium: premium(0.003),
      deribitSkew: skew(-0.015),
    });
    expect(r.bias).toBe("bullish");
    expect(r.confidence).toBe("low");
    expect(r.interpretation).toContain("Signals disagree");
    expect(r.interpretation).toContain("net bullish lean");
    expect(r.interpretation).toContain("Skip regime-gated trades");
  });
});
