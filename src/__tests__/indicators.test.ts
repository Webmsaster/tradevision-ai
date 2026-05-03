import { describe, it, expect } from "vitest";
import { sma, ema, rsi, macd, atr, adx, Candle } from "@/utils/indicators";

describe("sma", () => {
  it("returns all nulls when period exceeds data", () => {
    expect(sma([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it("computes correct values for simple series", () => {
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(2);
    expect(result[3]).toBeCloseTo(3);
    expect(result[4]).toBeCloseTo(4);
  });
});

describe("ema", () => {
  it("returns all nulls when period exceeds data", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it("seeds with SMA then recurses with smoothing factor", () => {
    const result = ema([1, 2, 3, 4, 5], 3);
    expect(result[2]).toBeCloseTo(2);
    const k = 2 / 4;
    const expected3 = 4 * k + 2 * (1 - k);
    const expected4 = 5 * k + expected3 * (1 - k);
    expect(result[3]).toBeCloseTo(expected3);
    expect(result[4]).toBeCloseTo(expected4);
  });

  it("approaches monotonic trend", () => {
    const rising = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = ema(rising, 9);
    for (let i = 10; i < result.length; i++) {
      expect(result[i]!).toBeGreaterThan(result[i - 1]!);
    }
  });

  // Round 56 (R56-IND-1): a NaN sample used to poison every subsequent
  // EMA value forever (NaN * anything = NaN). Verify self-heal.
  it("self-heals after a single NaN sample", () => {
    // Period 2 → seed window covers samples [0,1]; NaN at index 2 must
    // not freeze every later value at NaN.
    const result = ema([1, 2, NaN, 4, 5], 2);
    expect(result[1]!).toBeCloseTo(1.5); // SMA seed of [1,2]
    expect(Number.isFinite(result[3]!)).toBe(true);
    expect(Number.isFinite(result[4]!)).toBe(true);
    // After NaN we hold the previous valid (1.5) then recurse normally.
    const k = 2 / (2 + 1);
    const expected3 = 4 * k + 1.5 * (1 - k);
    const expected4 = 5 * k + expected3 * (1 - k);
    expect(result[3]!).toBeCloseTo(expected3);
    expect(result[4]!).toBeCloseTo(expected4);
  });
});

describe("rsi", () => {
  it("returns null for periods without enough data", () => {
    const result = rsi([1, 2, 3], 14);
    expect(result.every((v) => v === null)).toBe(true);
  });

  it("returns 100 for strictly rising series", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = rsi(rising, 14);
    expect(result[14]).toBeCloseTo(100);
    expect(result.at(-1)).toBeCloseTo(100);
  });

  it("returns low value for strictly falling series", () => {
    const falling = Array.from({ length: 30 }, (_, i) => 200 - i);
    const result = rsi(falling, 14);
    expect(result.at(-1)!).toBeLessThan(5);
  });

  it("lies within [0,100] for mixed series", () => {
    const prices = Array.from(
      { length: 60 },
      (_, i) => 100 + Math.sin(i / 3) * 5,
    );
    const result = rsi(prices, 14);
    for (const v of result) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  // Round 56 (R56-IND-1): a NaN sample mid-stream must not freeze RSI at NaN.
  it("self-heals after a single NaN sample", () => {
    const len = 30;
    const data: number[] = Array.from({ length: len }, (_, i) => 100 + i);
    data[20] = NaN;
    const result = rsi(data, 14);
    // Bar with NaN holds the previous valid reading (no NaN propagation).
    expect(Number.isFinite(result[20]!)).toBe(true);
    // Subsequent bars remain finite and within bounds.
    for (let i = 21; i < len; i++) {
      expect(Number.isFinite(result[i]!)).toBe(true);
      expect(result[i]!).toBeGreaterThanOrEqual(0);
      expect(result[i]!).toBeLessThanOrEqual(100);
    }
  });
});

describe("macd", () => {
  it("produces null values before enough data for slow EMA", () => {
    const short = Array.from({ length: 10 }, (_, i) => i + 1);
    const { macd: m, signal, histogram } = macd(short, 12, 26, 9);
    expect(m.every((v) => v === null)).toBe(true);
    expect(signal.every((v) => v === null)).toBe(true);
    expect(histogram.every((v) => v === null)).toBe(true);
  });

  it("produces macd and signal after enough data", () => {
    const data = Array.from(
      { length: 80 },
      (_, i) => 100 + Math.sin(i / 4) * 10,
    );
    const { macd: m, signal, histogram } = macd(data, 12, 26, 9);
    expect(m.at(-1)).not.toBeNull();
    expect(signal.at(-1)).not.toBeNull();
    expect(histogram.at(-1)).not.toBeNull();
    expect(histogram.at(-1)!).toBeCloseTo(
      (m.at(-1) as number) - (signal.at(-1) as number),
    );
  });
});

function candle(
  open: number,
  high: number,
  low: number,
  close: number,
  t = 0,
): Candle {
  return {
    openTime: t,
    open,
    high,
    low,
    close,
    volume: 100,
    closeTime: t + 60_000,
    isFinal: true,
  };
}

describe("adx", () => {
  it("returns all nulls without enough data", () => {
    const cs: Candle[] = Array.from({ length: 10 }, (_, i) =>
      candle(100, 101, 99, 100, i),
    );
    const result = adx(cs, 14);
    expect(result.adx.every((v) => v === null)).toBe(true);
  });

  it("reports high ADX for a strong trend", () => {
    const cs: Candle[] = Array.from({ length: 80 }, (_, i) =>
      candle(100 + i, 100 + i + 1, 100 + i - 0.2, 100 + i + 0.9, i * 60_000),
    );
    const result = adx(cs, 14);
    const last = result.adx.at(-1);
    expect(last).not.toBeNull();
    expect(last!).toBeGreaterThan(40);
    expect(result.plusDi.at(-1)!).toBeGreaterThan(result.minusDi.at(-1)!);
  });

  it("reports low ADX for a ranging market", () => {
    // Tight oscillation around 100
    const cs: Candle[] = Array.from({ length: 80 }, (_, i) => {
      const mid = 100 + (i % 2 === 0 ? 0.05 : -0.05);
      return candle(mid, mid + 0.1, mid - 0.1, mid, i * 60_000);
    });
    const result = adx(cs, 14);
    const last = result.adx.at(-1);
    expect(last).not.toBeNull();
    expect(last!).toBeLessThan(30);
  });
});

describe("atr", () => {
  it("returns nulls when insufficient data", () => {
    const candles: Candle[] = [candle(1, 2, 1, 1.5)];
    expect(atr(candles, 14).every((v) => v === null)).toBe(true);
  });

  it("produces positive value on varying candles", () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
      candle(100 + i, 100 + i + 2, 100 + i - 1, 100 + i + 1, i * 60_000),
    );
    const result = atr(candles, 14);
    expect(result[14]).not.toBeNull();
    expect(result[14]!).toBeGreaterThan(0);
  });

  // Round 56 (R56-IND-1): a NaN OHLC value used to poison every later
  // ATR sample via Wilder smoothing. Verify self-heal.
  it("self-heals after a NaN OHLC sample", () => {
    const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
      candle(100 + i, 100 + i + 2, 100 + i - 1, 100 + i + 1, i * 60_000),
    );
    // Inject a broken candle at index 20.
    candles[20] = candle(NaN, NaN, NaN, NaN, 20 * 60_000);
    const result = atr(candles, 14);
    // The broken bar holds the previous ATR (no NaN propagation).
    expect(Number.isFinite(result[20]!)).toBe(true);
    expect(result[20]!).toBeGreaterThan(0);
    // Subsequent bars remain finite.
    for (let i = 21; i < 30; i++) {
      expect(Number.isFinite(result[i]!)).toBe(true);
      expect(result[i]!).toBeGreaterThan(0);
    }
  });
});
