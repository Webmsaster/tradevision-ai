/**
 * 2026-05-15 — SMC FVG voter tests. Mirrors Rust `signals_smc_fvg.rs` fixtures.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "@/utils/indicators";
import {
  computeSmcFvgVote,
  defaultFvgParams,
} from "@/utils/regimeVoters/smcFvg";

function mk(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): Candle {
  return {
    openTime: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    closeTime: t + 1_800_000,
    isFinal: true,
  };
}

describe("computeSmcFvgVote", () => {
  it("abstains on flat range — no impulse, no gap, no vote", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    const v = computeSmcFvgVote(candles, defaultFvgParams());
    expect(v).toBeNull();
  });

  it("votes long on clean 3-bar gap-up + retest", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    candles[10] = mk(10 * 1_800_000, 100, 100.5, 99.5, 100, 100);
    candles[11] = mk(11 * 1_800_000, 100, 102.2, 99.9, 102, 200);
    candles[12] = mk(12 * 1_800_000, 102, 102.5, 101, 102, 100);
    for (let i = 13; i < 28; i++)
      candles[i] = mk(i * 1_800_000, 102, 102.5, 101.5, 102, 100);
    candles[28] = mk(28 * 1_800_000, 101.6, 102, 100.6, 101.7, 100);
    candles[29] = mk(29 * 1_800_000, 101.7, 102, 101, 101.7, 100);
    const v = computeSmcFvgVote(candles, defaultFvgParams());
    expect(v).toBe("long");
  });

  it("votes short on symmetric bearish FVG", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    candles[10] = mk(10 * 1_800_000, 100, 100.5, 99.5, 100, 100);
    candles[11] = mk(11 * 1_800_000, 100, 100.1, 97.8, 98, 200);
    candles[12] = mk(12 * 1_800_000, 98, 99, 97.5, 98, 100);
    for (let i = 13; i < 28; i++)
      candles[i] = mk(i * 1_800_000, 98, 98.5, 97.5, 98, 100);
    candles[28] = mk(28 * 1_800_000, 98.4, 99.4, 98, 98.3, 100);
    candles[29] = mk(29 * 1_800_000, 98.3, 99, 98, 98.3, 100);
    const v = computeSmcFvgVote(candles, defaultFvgParams());
    expect(v).toBe("short");
  });

  it("excludes signal bar from FVG anchor (no self-fulfilling)", () => {
    // Construct a fixture where (26,27,28) would form a gap if buggy impl
    // included signal bar in anchor. Correct impl: k+2 ≤ signal_idx-1 ⇒
    // k ≤ 25, so this fake (26,27,28) anchor must NOT fire.
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    candles[26] = mk(26 * 1_800_000, 100, 100.5, 99.5, 100, 100);
    candles[27] = mk(27 * 1_800_000, 100, 102.2, 99.9, 102, 200);
    candles[28] = mk(28 * 1_800_000, 102, 102.5, 101, 101.6, 100);
    candles[29] = mk(29 * 1_800_000, 101.6, 102, 101, 101.6, 100);
    const v = computeSmcFvgVote(candles, defaultFvgParams());
    expect(v).toBeNull();
  });

  it("handles NaN signal-bar open safely (no vote)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    candles[28] = mk(28 * 1_800_000, NaN, 100.5, 99.5, 100, 100);
    expect(computeSmcFvgVote(candles, defaultFvgParams())).toBeNull();
  });

  it("handles too-few candles safely", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    expect(computeSmcFvgVote(candles, defaultFvgParams())).toBeNull();
  });

  it("skips sub-min-width gaps", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    // tiny gap ~0.05% — below 0.15% default floor.
    candles[10] = mk(10 * 1_800_000, 100, 100.5, 99.5, 100, 100);
    candles[11] = mk(11 * 1_800_000, 100, 100.8, 100, 100.7, 200);
    candles[12] = mk(12 * 1_800_000, 100.7, 100.8, 100.55, 100.7, 100);
    for (let i = 13; i < 28; i++)
      candles[i] = mk(i * 1_800_000, 100.7, 100.8, 100.5, 100.7, 100);
    candles[28] = mk(28 * 1_800_000, 100.6, 100.7, 100.45, 100.6, 100);
    candles[29] = mk(29 * 1_800_000, 100.6, 100.7, 100.5, 100.6, 100);
    expect(computeSmcFvgVote(candles, defaultFvgParams())).toBeNull();
  });
});
