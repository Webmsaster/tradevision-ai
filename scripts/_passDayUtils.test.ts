/**
 * Unit tests for the corrected helpers in _passDayUtils.ts.
 * These guard against regression of the percentile off-by-one,
 * the pass-day under-count, and the silent time-misalignment bugs
 * surfaced in Round 4.
 */
import { describe, it, expect } from "vitest";
import {
  pick,
  computePassDay,
  assertAligned,
  shuffled,
  shuffleInPlace,
  mkRng,
} from "./_passDayUtils";
import type {
  FtmoDaytrade24hResult,
  Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";

describe("pick (percentile)", () => {
  it("returns NaN on empty input", () => {
    expect(Number.isNaN(pick([], 0.5))).toBe(true);
    expect(Number.isNaN(pick([], 0))).toBe(true);
    expect(Number.isNaN(pick([], 1))).toBe(true);
  });

  it("q=1 lands on the last element (was OOB with old floor formula)", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(pick(arr, 1)).toBe(10);
  });

  it("q=0 lands on the first element", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(pick(arr, 0)).toBe(1);
  });

  it("ceil-based indexing matches FTMO daytrade conventions for n=10", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // ceil(10*0.5) - 1 = 4 → arr[4] = 5
    expect(pick(arr, 0.5)).toBe(5);
    // ceil(10*0.9) - 1 = 8 → arr[8] = 9
    expect(pick(arr, 0.9)).toBe(9);
    // ceil(10*0.25) - 1 = 2 → arr[2] = 3
    expect(pick(arr, 0.25)).toBe(3);
  });

  it("works for a single-element array", () => {
    expect(pick([42], 0)).toBe(42);
    expect(pick([42], 0.5)).toBe(42);
    expect(pick([42], 1)).toBe(42);
  });
});

describe("computePassDay", () => {
  const mkResult = (
    passed: boolean,
    uniqueTradingDays: number,
    lastTradeDay: number | null,
  ): FtmoDaytrade24hResult => ({
    passed,
    reason: "profit_target",
    finalEquityPct: 1.1,
    maxDrawdown: 0.02,
    uniqueTradingDays,
    maxHoldHoursObserved: 4,
    trades:
      lastTradeDay === null
        ? []
        : ([
            {
              symbol: "X",
              direction: "long",
              entryTime: 0,
              exitTime: 0,
              entryPrice: 1,
              exitPrice: 1,
              rawPnl: 0,
              effPnl: 0,
              day: lastTradeDay,
              exitReason: "tp",
              holdHours: 1,
            },
          ] as Daytrade24hTrade[]),
  });

  it("returns 0 for failed runs", () => {
    expect(computePassDay(mkResult(false, 5, 4))).toBe(0);
  });

  it("returns 0 when there are no trades", () => {
    expect(computePassDay(mkResult(true, 5, null))).toBe(0);
  });

  it("uses uniqueTradingDays when it exceeds lastTrade.day+1 (pause-at-target case)", () => {
    // pauseAtTargetReached can end the engine on a day where the last trade
    // entry was earlier — uniqueTradingDays is the higher-fidelity count.
    expect(computePassDay(mkResult(true, 6, 3))).toBe(6);
  });

  it("uses lastTrade.day+1 when it exceeds uniqueTradingDays (sparse trading)", () => {
    expect(computePassDay(mkResult(true, 2, 4))).toBe(5);
  });
});

describe("assertAligned", () => {
  const mkCandle = (openTime: number): Candle => ({
    openTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    closeTime: openTime + 1,
    isFinal: true,
  });

  it("passes when all assets share the same openTime sequence", () => {
    const data = {
      A: [mkCandle(1), mkCandle(2), mkCandle(3)],
      B: [mkCandle(1), mkCandle(2), mkCandle(3)],
    };
    expect(() => assertAligned(data)).not.toThrow();
  });

  it("throws on misalignment with index pinpointed", () => {
    const data = {
      A: [mkCandle(1), mkCandle(2), mkCandle(3)],
      B: [mkCandle(1), mkCandle(99), mkCandle(3)],
    };
    expect(() => assertAligned(data)).toThrow(/index 1/);
  });

  it("only checks the overlap range", () => {
    const data = {
      A: [mkCandle(1), mkCandle(2)],
      B: [mkCandle(1), mkCandle(2), mkCandle(3)],
    };
    expect(() => assertAligned(data)).not.toThrow();
  });
});

describe("shuffleInPlace / shuffled (Fisher-Yates)", () => {
  it("preserves all elements", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = shuffled(arr);
    expect(out.sort()).toEqual([...arr].sort());
  });

  it("does not mutate the input when using shuffled()", () => {
    const arr = [1, 2, 3, 4];
    const original = [...arr];
    shuffled(arr);
    expect(arr).toEqual(original);
  });

  it("is deterministic when given a seeded RNG", () => {
    const arr = Array.from({ length: 24 }, (_, i) => i);
    const a = shuffled(arr, mkRng(42));
    const b = shuffled(arr, mkRng(42));
    expect(a).toEqual(b);
  });

  it("produces a uniform distribution (no first-position bias)", () => {
    // Sanity: with N=10000 shuffles of [0..9], each element should
    // land at index 0 within ~25% of the expected count (1000).
    const counts = new Array(10).fill(0);
    const rng = mkRng(0xbeef);
    for (let t = 0; t < 10000; t++) {
      const out = shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rng);
      counts[out[0]]++;
    }
    // Each bucket should be roughly 1000 ± 250 (very loose bound).
    for (const c of counts) {
      expect(c).toBeGreaterThan(700);
      expect(c).toBeLessThan(1300);
    }
  });
});

describe("mkRng (mulberry32)", () => {
  it("is deterministic for the same seed", () => {
    const r1 = mkRng(123);
    const r2 = mkRng(123);
    for (let i = 0; i < 100; i++) expect(r1()).toBe(r2());
  });

  it("produces different streams for different seeds", () => {
    const r1 = mkRng(1);
    const r2 = mkRng(2);
    expect(r1()).not.toBe(r2());
  });

  it("stays within [0,1)", () => {
    const r = mkRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
