import { describe, it, expect } from "vitest";
import {
  evaluateVolumeSpikeSignal,
  SOL_FADE_CONFIG,
} from "@/utils/volumeSpikeSignal";
import type { Candle } from "@/utils/indicators";

function makeBars(n: number, basePrice = 100, baseVol = 1000): Candle[] {
  const bars: Candle[] = [];
  let p = basePrice;
  for (let i = 0; i < n; i++) {
    p = p * (1 + Math.sin(i / 7) * 0.005);
    bars.push({
      openTime: i * 3_600_000,
      open: p * 0.999,
      high: p * 1.002,
      low: p * 0.998,
      close: p,
      volume: baseVol,
      closeTime: i * 3_600_000 + 3_599_999,
      isFinal: true,
    });
  }
  return bars;
}

describe("volumeSpikeSignal", () => {
  it("returns inactive when not enough history", () => {
    const snap = evaluateVolumeSpikeSignal("SOLUSDT", makeBars(10));
    expect(snap.active).toBe(false);
    expect(snap.reason).toMatch(/Insufficient/i);
  });

  it("does not fire when no spike present", () => {
    const bars = makeBars(60);
    const snap = evaluateVolumeSpikeSignal("SOLUSDT", bars);
    expect(snap.active).toBe(false);
    expect(snap.reason).toMatch(/No spike/i);
    expect(snap.vZ).toBeGreaterThanOrEqual(0);
  });

  it("fires SHORT when last bar is up + volume + price spike (fade mode)", () => {
    const bars = makeBars(60);
    // Inflate last bar: 5× volume, +3% close
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    last.volume = 1000 * 6;
    last.close = prev.close * 1.03;
    last.high = last.close * 1.001;
    last.low = prev.close;
    const snap = evaluateVolumeSpikeSignal("SOLUSDT", bars, SOL_FADE_CONFIG);
    expect(snap.active).toBe(true);
    expect(snap.direction).toBe("short");
    expect(snap.entry).toBeCloseTo(last.close, 5);
    expect(snap.stop).toBeGreaterThan(last.close); // stop above for short
    expect(snap.exitAt).toBe(last.closeTime + 4 * 60 * 60 * 1000);
  });

  it("fires LONG when last bar is down + volume + price spike (fade mode)", () => {
    const bars = makeBars(60);
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    last.volume = 1000 * 6;
    last.close = prev.close * 0.97;
    last.high = prev.close;
    last.low = last.close * 0.999;
    const snap = evaluateVolumeSpikeSignal("SOLUSDT", bars, SOL_FADE_CONFIG);
    expect(snap.active).toBe(true);
    expect(snap.direction).toBe("long");
    expect(snap.stop).toBeLessThan(last.close);
  });

  it("momentum mode flips direction", () => {
    const bars = makeBars(60);
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    last.volume = 1000 * 6;
    last.close = prev.close * 1.03;
    const snap = evaluateVolumeSpikeSignal("SOLUSDT", bars, {
      ...SOL_FADE_CONFIG,
      mode: "momentum",
    });
    expect(snap.active).toBe(true);
    expect(snap.direction).toBe("long");
  });
});
