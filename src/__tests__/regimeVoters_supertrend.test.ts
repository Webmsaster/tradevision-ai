/**
 * 2026-05-15 — Supertrend voter tests. Mirrors Rust
 * `signals_supertrend.rs` unit-test fixtures.
 */
import { describe, it, expect } from "vitest";
import type { Candle } from "@/utils/indicators";
import {
  computeSupertrendVote,
  defaultSupertrendParams,
} from "@/utils/regimeVoters/supertrend";

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

describe("computeSupertrendVote", () => {
  it("votes long on strong uptrend", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + i;
      candles.push(mk(i * 1_800_000, c - 0.2, c + 0.5, c - 0.5, c, 100));
    }
    const v = computeSupertrendVote(candles, { atrPeriod: 10, multiplier: 2 });
    expect(v).toBe("long");
  });

  it("votes short on strong downtrend", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 200 - i;
      candles.push(mk(i * 1_800_000, c + 0.2, c + 0.5, c - 0.5, c, 100));
    }
    const v = computeSupertrendVote(candles, { atrPeriod: 10, multiplier: 2 });
    expect(v).toBe("short");
  });

  it("abstains when ATR=0 (perfectly flat candles)", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      candles.push(mk(i * 1_800_000, 100, 100, 100, 100, 100));
    }
    const v = computeSupertrendVote(candles, defaultSupertrendParams());
    expect(v).toBeNull();
  });

  it("lookahead-safe — NaN-poisoned entry bar does not change vote", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = 100 + i;
      candles.push(mk(i * 1_800_000, c - 0.2, c + 0.5, c - 0.5, c, 100));
    }
    const last = candles.length - 1;
    candles[last] = mk(last * 1_800_000, NaN, NaN, NaN, NaN, 0);
    const v = computeSupertrendVote(candles, { atrPeriod: 10, multiplier: 2 });
    expect(v).toBe("long");
  });

  it("handles too-few candles safely", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++)
      candles.push(mk(i * 1_800_000, 100, 100.5, 99.5, 100, 100));
    expect(
      computeSupertrendVote(candles, defaultSupertrendParams()),
    ).toBeNull();
  });

  it("tight vs wide multiplier produce different decisions on fresh reversal", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = i < 35 ? 100 + i : 135 - (i - 35) * 2;
      candles.push(mk(i * 1_800_000, c - 0.2, c + 0.5, c - 0.5, c, 100));
    }
    const vTight = computeSupertrendVote(candles, {
      atrPeriod: 10,
      multiplier: 1,
    });
    const vWide = computeSupertrendVote(candles, {
      atrPeriod: 10,
      multiplier: 5,
    });
    expect(vTight).not.toBe(vWide);
  });
});
