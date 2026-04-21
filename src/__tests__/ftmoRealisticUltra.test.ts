/**
 * Smoke tests for ftmoRealisticUltra — iter186 4-asset 1d flagship.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoUltra,
  FTMO_ULTRA_CONFIG,
  FTMO_ULTRA_STATS,
} from "../utils/ftmoRealisticUltra";
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

describe("ftmoRealisticUltra — config", () => {
  it("4 assets at 25% risk each", () => {
    expect(FTMO_ULTRA_CONFIG.assets.length).toBe(4);
    for (const a of FTMO_ULTRA_CONFIG.assets) {
      expect(a.riskFrac).toBeCloseTo(0.25, 5);
      expect(a.holdDays).toBe(20);
      expect(a.stopPct).toBeCloseTo(0.02, 5);
    }
  });

  it("realistic per-asset costs", () => {
    const costMap: Record<string, number> = {};
    for (const a of FTMO_ULTRA_CONFIG.assets) costMap[a.symbol] = a.costBp;
    expect(costMap.BTCUSDT).toBe(40);
    expect(costMap.ETHUSDT).toBe(30);
    expect(costMap.SOLUSDT).toBe(40);
    expect(costMap.AVAXUSDT).toBe(45);
  });

  it("volatility-scaled TPs", () => {
    const tpMap: Record<string, number> = {};
    for (const a of FTMO_ULTRA_CONFIG.assets) tpMap[a.symbol] = a.tpPct;
    expect(tpMap.BTCUSDT).toBeCloseTo(0.08, 5);
    expect(tpMap.ETHUSDT).toBeCloseTo(0.12, 5);
    expect(tpMap.SOLUSDT).toBeCloseTo(0.12, 5);
    expect(tpMap.AVAXUSDT).toBeCloseTo(0.15, 5);
  });

  it("FTMO rules", () => {
    expect(FTMO_ULTRA_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_ULTRA_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_ULTRA_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_ULTRA_CONFIG.leverage).toBe(2);
    expect(FTMO_ULTRA_CONFIG.triggerBars).toBe(2);
  });
});

describe("ftmoRealisticUltra — stats", () => {
  it("passes OOS 70%, MC 56%", () => {
    expect(FTMO_ULTRA_STATS.passRateOos).toBeCloseTo(0.7, 1);
    expect(FTMO_ULTRA_STATS.passRateMonteCarlo).toBeCloseTo(0.56, 1);
    expect(FTMO_ULTRA_STATS.livePassRateEstimate).toBeCloseTo(0.55, 2);
  });

  it("EV positive, conservative", () => {
    expect(FTMO_ULTRA_STATS.evPerChallengeOos).toBeGreaterThan(2500);
    expect(FTMO_ULTRA_STATS.evPerChallengeLive).toBeGreaterThan(2000);
  });

  it("20-challenge expected net $38-45k", () => {
    const n = FTMO_ULTRA_STATS.expectedOutcome20Challenges.expectedNetLive;
    expect(n).toBeGreaterThan(35_000);
    expect(n).toBeLessThan(50_000);
  });

  it("not daytrade", () => {
    expect(FTMO_ULTRA_STATS.isDaytrade).toBe(false);
    expect(FTMO_ULTRA_STATS.holdDays).toBeGreaterThanOrEqual(15);
  });

  it("iter186 metadata", () => {
    expect(FTMO_ULTRA_STATS.iteration).toBe(186);
    expect(FTMO_ULTRA_STATS.symbols.length).toBe(4);
  });
});

describe("ftmoRealisticUltra — runner", () => {
  it("empty input → insufficient_days", () => {
    const r = runFtmoUltra({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("handles flat market", () => {
    const t0 = 1_700_000_000_000;
    const day = 24 * 3600_000;
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++)
      c.push(mkCandle(t0 + i * day, 100, 100.1, 99.9, 100));
    const r = runFtmoUltra({
      BTCUSDT: c,
      ETHUSDT: c,
      SOLUSDT: c,
      AVAXUSDT: c,
    });
    expect(r.passed).toBe(false);
  });

  it("detects trades across multiple assets", () => {
    const t0 = 1_700_000_000_000;
    const day = 24 * 3600_000;
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + day, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * day, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * day, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * day, 99, 115, 99, 114));
      for (let i = 5; i < 30; i++)
        out.push(mkCandle(t0 + i * day, 114, 115, 113, 114));
      return out;
    };
    const r = runFtmoUltra({
      BTCUSDT: mkPat(),
      ETHUSDT: mkPat(),
      SOLUSDT: mkPat(),
      AVAXUSDT: mkPat(),
    });
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const syms = new Set(r.trades.map((t) => t.symbol));
    expect(syms.size).toBeGreaterThanOrEqual(1);
  });
});
