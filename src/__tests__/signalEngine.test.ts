import { describe, it, expect } from "vitest";
import { analyzeCandles, hasActionChanged } from "@/utils/signalEngine";
import type { Candle } from "@/utils/indicators";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 100,
    closeTime: (i + 1) * 60_000,
    isFinal: true,
  }));
}

describe("analyzeCandles", () => {
  it("returns null when not enough candles", () => {
    const candles = makeCandles(Array.from({ length: 10 }, (_, i) => 100 + i));
    expect(analyzeCandles(candles)).toBeNull();
  });

  it("produces a long signal on sustained uptrend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("long");
    expect(snap!.indicators.emaFast).toBeGreaterThan(snap!.indicators.emaSlow!);
  });

  it("produces a short signal on sustained downtrend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("short");
    expect(snap!.indicators.emaFast).toBeLessThan(snap!.indicators.emaSlow!);
  });

  it("produces flat on perfectly flat market", () => {
    const closes = Array.from({ length: 60 }, () => 100);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("flat");
  });

  it("emits human-readable reason strings", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap!.reasons.length).toBeGreaterThan(0);
    expect(snap!.reasons.join(" ")).toMatch(/EMA|RSI|MACD/);
  });

  it("bounds strength between 0 and 10", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap!.strength).toBeGreaterThanOrEqual(0);
    expect(snap!.strength).toBeLessThanOrEqual(10);
  });
});

describe("hasActionChanged", () => {
  it("returns true when prev is null and next is non-flat", () => {
    const next = { action: "long" } as any;
    expect(hasActionChanged(null, next)).toBe(true);
  });

  it("returns false when prev is null and next is flat", () => {
    const next = { action: "flat" } as any;
    expect(hasActionChanged(null, next)).toBe(false);
  });

  it("returns true when action changes", () => {
    expect(
      hasActionChanged({ action: "long" } as any, { action: "short" } as any),
    ).toBe(true);
    expect(
      hasActionChanged({ action: "flat" } as any, { action: "long" } as any),
    ).toBe(true);
  });

  it("returns false when action is the same", () => {
    expect(
      hasActionChanged({ action: "long" } as any, { action: "long" } as any),
    ).toBe(false);
  });
});
