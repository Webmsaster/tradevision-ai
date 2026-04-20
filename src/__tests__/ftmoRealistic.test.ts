/**
 * Smoke tests for ftmoRealistic — iter181 honest swing strategy.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoRealistic,
  FTMO_REALISTIC_CONFIG,
  FTMO_REALISTIC_STATS,
} from "../utils/ftmoRealistic";
import type { Candle } from "../utils/indicators";

function mkCandle(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return {
    openTime: t,
    closeTime: t + 24 * 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

describe("ftmoRealistic — config", () => {
  it("uses realistic 1d swing params", () => {
    expect(FTMO_REALISTIC_CONFIG.tpPct).toBeCloseTo(0.08, 5);
    expect(FTMO_REALISTIC_CONFIG.stopPct).toBeCloseTo(0.02, 5);
    expect(FTMO_REALISTIC_CONFIG.holdDays).toBe(10);
    expect(FTMO_REALISTIC_CONFIG.realisticCostBp).toBe(20);
    expect(FTMO_REALISTIC_CONFIG.leverage).toBe(2);
  });

  it("TP:Stop ratio 4:1", () => {
    const ratio = FTMO_REALISTIC_CONFIG.tpPct / FTMO_REALISTIC_CONFIG.stopPct;
    expect(ratio).toBeCloseTo(4, 2);
  });

  it("FTMO rules encoded", () => {
    expect(FTMO_REALISTIC_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_REALISTIC_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_REALISTIC_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_REALISTIC_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_REALISTIC_CONFIG.maxDays).toBe(30);
  });
});

describe("ftmoRealistic — stats", () => {
  it("honest ~44% pass rate (NOT 100%)", () => {
    expect(FTMO_REALISTIC_STATS.passRateNonOverlapping).toBeGreaterThan(0.4);
    expect(FTMO_REALISTIC_STATS.passRateNonOverlapping).toBeLessThan(0.5);
    expect(FTMO_REALISTIC_STATS.livePassRateEstimate).toBeCloseTo(0.4, 2);
  });

  it("EV positive but modest (not $3k+)", () => {
    expect(FTMO_REALISTIC_STATS.evPerChallenge).toBeGreaterThan(1000);
    expect(FTMO_REALISTIC_STATS.evPerChallenge).toBeLessThan(2500);
  });

  it("explicitly NOT daytrade", () => {
    expect(FTMO_REALISTIC_STATS.isDaytrade).toBe(false);
    expect(FTMO_REALISTIC_STATS.holdDays).toBeGreaterThanOrEqual(5);
  });

  it("20-challenge net ~$30k", () => {
    expect(
      FTMO_REALISTIC_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeGreaterThan(25_000);
    expect(
      FTMO_REALISTIC_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeLessThan(40_000);
  });

  it("iter181 metadata", () => {
    expect(FTMO_REALISTIC_STATS.iteration).toBe(181);
    expect(FTMO_REALISTIC_STATS.symbol).toBe("ETHUSDT");
    expect(FTMO_REALISTIC_STATS.timeframe).toBe("1d");
  });
});

describe("ftmoRealistic — runner", () => {
  it("insufficient_days on flat market", () => {
    const t0 = 1_700_000_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mkCandle(t0 + i * 24 * 3600_000, 100, 100.5, 99.5, 100));
    const r = runFtmoRealistic(candles);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("long triggers on 2-down days and applies realistic cost", () => {
    const t0 = 1_700_000_000_000;
    const dayMs = 24 * 3600_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + dayMs, 100, 101, 99, 101));
    candles.push(mkCandle(t0 + 2 * dayMs, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * dayMs, 100, 100, 99, 99));
    // entry 99, TP at 99*1.08 = 106.92, stop at 99*0.98 = 97.02
    // Day 4: big rally up to 108 → TP hit
    candles.push(mkCandle(t0 + 4 * dayMs, 99, 108, 99, 107));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * dayMs, 107, 107.5, 106, 107));
    const r = runFtmoRealistic(candles);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    // Real pnl should be less than raw 8% due to cost
    if (r.trades.length > 0) {
      expect(r.trades[0].rawPnl).toBeLessThan(0.08);
      expect(r.trades[0].rawPnl).toBeGreaterThan(0.07);
    }
  });
});
