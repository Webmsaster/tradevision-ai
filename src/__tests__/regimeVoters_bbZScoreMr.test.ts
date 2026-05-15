/**
 * 2026-05-15 — BB-Z-Score MR voter tests. Mirrors Rust
 * `signals_bb_zscore_mr.rs` unit-test fixtures literally.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "@/utils/indicators";
import {
  computeBbZScoreVote,
  defaultBbZScoreSource,
} from "@/utils/regimeVoters/bbZScoreMr";

function mkCandle(
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

/** Rust `oversold_cross_back_series()` translated 1:1. */
function oversoldCrossBackSeries(): Candle[] {
  const v: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const osc = i % 2 === 0 ? 100.5 : 99.5;
    v.push(mkCandle(i * 1_800_000, osc, osc + 0.2, osc - 0.2, osc, 1.0));
  }
  v.push(mkCandle(40 * 1_800_000, 100.0, 100.0, 90.0, 90.0, 1.0));
  v.push(mkCandle(41 * 1_800_000, 93.0, 98.5, 92.5, 98.0, 1.0));
  v.push(mkCandle(42 * 1_800_000, 98.5, 99.0, 98.0, 98.7, 1.0));
  return v;
}

describe("computeBbZScoreVote", () => {
  it("votes long on oversold cross-back fixture", () => {
    const v = computeBbZScoreVote(
      oversoldCrossBackSeries(),
      defaultBbZScoreSource(),
    );
    expect(v).toBe("long");
  });

  it("abstains when z stays inside the bands (tight oscillation)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const osc = i % 2 === 0 ? 100.2 : 99.8;
      candles.push(
        mkCandle(i * 1_800_000, osc, osc + 0.1, osc - 0.1, osc, 1.0),
      );
    }
    const v = computeBbZScoreVote(candles, defaultBbZScoreSource());
    expect(v).toBeNull();
  });

  it("abstains when std collapses to zero (flat market)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(mkCandle(i * 1_800_000, 100, 100, 100, 100, 1));
    }
    const v = computeBbZScoreVote(candles, defaultBbZScoreSource());
    expect(v).toBeNull();
  });

  it("lookahead-safe — mutating entry bar (len-1) close does not change the vote", () => {
    const a = oversoldCrossBackSeries();
    const b = a.map((c) => ({ ...c }));
    // Mutate entry bar — crash to 1.0.
    b[b.length - 1] = { ...b[b.length - 1]!, close: 1.0, high: 1.0, low: 0.5 };
    const va = computeBbZScoreVote(a, defaultBbZScoreSource());
    const vb = computeBbZScoreVote(b, defaultBbZScoreSource());
    expect(vb).toBe(va);
  });

  it("votes short on symmetric overbought fixture", () => {
    const v: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const osc = i % 2 === 0 ? 100.5 : 99.5;
      v.push(mkCandle(i * 1_800_000, osc, osc + 0.2, osc - 0.2, osc, 1));
    }
    v.push(mkCandle(40 * 1_800_000, 100, 110, 100, 110, 1));
    v.push(mkCandle(41 * 1_800_000, 107, 107.5, 101.5, 102, 1));
    v.push(mkCandle(42 * 1_800_000, 101.5, 102, 101, 101.7, 1));
    const vote = computeBbZScoreVote(v, defaultBbZScoreSource());
    expect(vote).toBe("short");
  });

  it("safely abstains on too-few candles", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++)
      candles.push(mkCandle(i * 1_800_000, 100, 100.5, 99.5, 100, 1));
    expect(computeBbZScoreVote(candles, defaultBbZScoreSource())).toBeNull();
  });

  it("safely abstains with bbPeriod=0", () => {
    const candles = oversoldCrossBackSeries();
    expect(
      computeBbZScoreVote(candles, {
        ...defaultBbZScoreSource(),
        bbPeriod: 0,
      }),
    ).toBeNull();
  });
});
