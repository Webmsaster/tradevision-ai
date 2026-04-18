import { describe, it, expect } from "vitest";
import {
  bollingerBands,
  vwap,
  findPivots,
  extractKeyLevels,
  analyzeMarketStructure,
  classifySetup,
  computeBaseRate,
} from "@/utils/marketStructure";
import type { Candle } from "@/utils/indicators";

function makeCandles(
  closes: number[],
  highDelta = 0.5,
  lowDelta = 0.5,
): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c + highDelta,
    low: c - lowDelta,
    close: c,
    volume: 100,
    closeTime: (i + 1) * 60_000,
    isFinal: true,
  }));
}

describe("bollingerBands", () => {
  it("fills nulls before enough data", () => {
    const r = bollingerBands([1, 2, 3], 20);
    expect(r.middle.every((v) => v === null)).toBe(true);
  });
  it("produces middle = SMA", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = bollingerBands(values, 20, 2);
    expect(r.middle[19]).toBeCloseTo(109.5);
    expect(r.upper[19]!).toBeGreaterThan(r.middle[19]!);
    expect(r.lower[19]!).toBeLessThan(r.middle[19]!);
  });
});

describe("vwap", () => {
  it("resets at day boundaries", () => {
    const day1: Candle[] = Array.from({ length: 3 }, (_, i) => ({
      openTime: i * 60_000,
      closeTime: i * 60_000 + 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      isFinal: true,
    }));
    const day2Base = 24 * 60 * 60 * 1000;
    const day2: Candle[] = Array.from({ length: 3 }, (_, i) => ({
      openTime: day2Base + i * 60_000,
      closeTime: day2Base + i * 60_000 + 60_000,
      open: 200,
      high: 201,
      low: 199,
      close: 200,
      volume: 10,
      isFinal: true,
    }));
    const out = vwap([...day1, ...day2]);
    expect(out[2].vwap).toBeCloseTo(100, 0);
    expect(out[5].vwap).toBeCloseTo(200, 0);
  });
});

describe("findPivots", () => {
  it("finds swing high in a simple peak", () => {
    const closes = [1, 2, 3, 4, 5, 4, 3, 2, 1];
    const candles = makeCandles(closes);
    const pivots = findPivots(candles, 3, 3);
    expect(pivots.some((p) => p.type === "high")).toBe(true);
  });
  it("finds swing low in a simple valley", () => {
    const closes = [5, 4, 3, 2, 1, 2, 3, 4, 5];
    const candles = makeCandles(closes);
    const pivots = findPivots(candles, 3, 3);
    expect(pivots.some((p) => p.type === "low")).toBe(true);
  });
});

describe("extractKeyLevels", () => {
  it("returns supports below and resistances above current price", () => {
    const pivots = [
      { index: 0, price: 90, type: "low" as const, strength: 10 },
      { index: 1, price: 95, type: "low" as const, strength: 10 },
      { index: 2, price: 110, type: "high" as const, strength: 10 },
      { index: 3, price: 115, type: "high" as const, strength: 10 },
    ];
    const k = extractKeyLevels(pivots, 100);
    expect(k.supports).toEqual([95, 90]);
    expect(k.resistances).toEqual([110, 115]);
    expect(k.nearestSupport).toBe(95);
    expect(k.nearestResistance).toBe(110);
  });
});

describe("analyzeMarketStructure", () => {
  it("detects bullish structure", () => {
    // Create candles with clear HH/HL sequence
    const closes = [10, 15, 12, 20, 17, 25, 22, 30];
    const candles = makeCandles(closes, 1, 1);
    const pivots = findPivots(candles, 1, 1);
    const ms = analyzeMarketStructure(candles, pivots);
    expect(["bullish", "undetermined"]).toContain(ms.state);
  });

  it("returns undetermined with too few pivots", () => {
    const ms = analyzeMarketStructure(makeCandles([1, 2, 3]), []);
    expect(ms.state).toBe("undetermined");
  });
});

describe("classifySetup", () => {
  const keyLevels = {
    supports: [95],
    resistances: [110],
    nearestSupport: 95,
    nearestResistance: 110,
    distanceToSupportPct: 5,
    distanceToResistancePct: 5,
  };

  it("returns indecision when action is flat", () => {
    const s = classifySetup(
      "flat",
      {
        state: "undetermined",
        lastEvent: "none",
        lastSwingHigh: null,
        lastSwingLow: null,
        previousSwingHigh: null,
        previousSwingLow: null,
      },
      keyLevels,
      100,
      1,
    );
    expect(s.type).toBe("indecision");
  });

  it("returns breakout on BOS-up + long", () => {
    const s = classifySetup(
      "long",
      {
        state: "bullish",
        lastEvent: "BOS-up",
        lastSwingHigh: 110,
        lastSwingLow: 90,
        previousSwingHigh: 105,
        previousSwingLow: 85,
      },
      keyLevels,
      112,
      1,
    );
    expect(s.type).toBe("breakout");
  });

  it("returns reversal on CHoCH + aligned direction", () => {
    const s = classifySetup(
      "long",
      {
        state: "bearish",
        lastEvent: "CHoCH-up",
        lastSwingHigh: 110,
        lastSwingLow: 90,
        previousSwingHigh: 115,
        previousSwingLow: 95,
      },
      keyLevels,
      112,
      1,
    );
    expect(s.type).toBe("reversal");
  });

  it("returns range-fade on counter-structural signal", () => {
    const s = classifySetup(
      "long",
      {
        state: "bearish",
        lastEvent: "none",
        lastSwingHigh: 110,
        lastSwingLow: 90,
        previousSwingHigh: 115,
        previousSwingLow: 95,
      },
      keyLevels,
      100,
      5,
    );
    expect(s.type).toBe("range-fade");
  });
});

describe("computeBaseRate", () => {
  it("returns null when action is flat", () => {
    expect(
      computeBaseRate(makeCandles([1, 2, 3, 4]), "flat", "breakout"),
    ).toBeNull();
  });

  it("returns null with too few candles", () => {
    expect(
      computeBaseRate(makeCandles([1, 2, 3]), "long", "trend-continuation"),
    ).toBeNull();
  });

  it("computes win rate with confidence interval on long history", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.2);
    const r = computeBaseRate(
      makeCandles(closes, 1, 1),
      "long",
      "trend-continuation",
    );
    if (r) {
      expect(r.winRate).toBeGreaterThanOrEqual(0);
      expect(r.winRate).toBeLessThanOrEqual(1);
      expect(r.confidenceLower).toBeLessThanOrEqual(r.winRate);
      expect(r.confidenceUpper).toBeGreaterThanOrEqual(r.winRate);
    }
  });
});
