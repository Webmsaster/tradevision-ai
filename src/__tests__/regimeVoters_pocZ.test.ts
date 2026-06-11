/**
 * 2026-05-15 — POC-Z voter tests.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "@/utils/indicators";
import { computePocZVote, defaultPocZParams } from "@/utils/regimeVoters/pocZ";

function mk(t: number, c: number, v: number): Candle {
  return {
    openTime: t,
    open: c,
    high: c + 0.1,
    low: c - 0.1,
    close: c,
    volume: v,
    closeTime: t + 1_800_000,
    isFinal: true,
  };
}

describe("computePocZVote", () => {
  it("abstains on flat range (std=0)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) candles.push(mk(i * 1_800_000, 100, 100));
    expect(computePocZVote(candles, defaultPocZParams())).toBeNull();
  });

  it("votes short when signal close is far above POC", () => {
    const candles: Candle[] = [];
    // Heavy volume at price 100 for 18 bars — POC anchored there.
    for (let i = 0; i < 18; i++) candles.push(mk(i * 1_800_000, 100, 1000));
    // Then 2 bars where price drifts up to make std nonzero, and final
    // signal bar far above POC.
    candles.push(mk(18 * 1_800_000, 101, 50));
    candles.push(mk(19 * 1_800_000, 102, 50));
    // signal bar (idx 20 = len-2) — at 115 (way above POC of ~100).
    candles.push(mk(20 * 1_800_000, 115, 50));
    // entry bar (placeholder).
    candles.push(mk(21 * 1_800_000, 115, 50));
    const v = computePocZVote(candles, {
      ...defaultPocZParams(),
      pocBucketPct: 0.005,
      pocZMin: 1.5,
    });
    expect(v).toBe("short");
  });

  it("votes long when signal close is far below POC", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 18; i++) candles.push(mk(i * 1_800_000, 100, 1000));
    candles.push(mk(18 * 1_800_000, 99, 50));
    candles.push(mk(19 * 1_800_000, 98, 50));
    candles.push(mk(20 * 1_800_000, 85, 50));
    candles.push(mk(21 * 1_800_000, 85, 50));
    const v = computePocZVote(candles, {
      ...defaultPocZParams(),
      pocBucketPct: 0.005,
      pocZMin: 1.5,
    });
    expect(v).toBe("long");
  });

  it("lookahead-safe — mutating entry bar (len-1) does not change vote", () => {
    const a: Candle[] = [];
    for (let i = 0; i < 18; i++) a.push(mk(i * 1_800_000, 100, 1000));
    a.push(mk(18 * 1_800_000, 101, 50));
    a.push(mk(19 * 1_800_000, 102, 50));
    a.push(mk(20 * 1_800_000, 115, 50));
    a.push(mk(21 * 1_800_000, 115, 50));
    const b = a.map((c) => ({ ...c }));
    // Crash entry bar (len-1 = idx 21) to extreme.
    b[21] = { ...b[21]!, close: 1, high: 1, low: 0.5, open: 1 };
    const va = computePocZVote(a, defaultPocZParams());
    const vb = computePocZVote(b, defaultPocZParams());
    expect(vb).toBe(va);
  });

  it("handles too-few candles safely", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) candles.push(mk(i * 1_800_000, 100, 100));
    expect(computePocZVote(candles, defaultPocZParams())).toBeNull();
  });

  it("safely abstains with pocWindowBars=0", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100 + i * 0.1, 100));
    expect(
      computePocZVote(candles, { ...defaultPocZParams(), pocWindowBars: 0 }),
    ).toBeNull();
  });

  it("safely abstains with pocBucketPct=0", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100 + i * 0.1, 100));
    expect(
      computePocZVote(candles, { ...defaultPocZParams(), pocBucketPct: 0 }),
    ).toBeNull();
  });
});
