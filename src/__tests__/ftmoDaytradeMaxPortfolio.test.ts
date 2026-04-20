/**
 * Smoke tests for ftmoDaytradeMaxPortfolio — iter179 4-asset flagship.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoMaxPortfolio,
  FTMO_MAX_PORTFOLIO_CONFIG,
  FTMO_MAX_PORTFOLIO_STATS,
} from "../utils/ftmoDaytradeMaxPortfolio";
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
    closeTime: t + 15 * 60_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

describe("ftmoDaytradeMaxPortfolio — config", () => {
  it("has 4 assets each at 33% risk", () => {
    expect(FTMO_MAX_PORTFOLIO_CONFIG.assets.length).toBe(4);
    const symbols = FTMO_MAX_PORTFOLIO_CONFIG.assets.map((a) => a.symbol);
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).toContain("ETHUSDT");
    expect(symbols).toContain("SOLUSDT");
    expect(symbols).toContain("AVAXUSDT");
    for (const a of FTMO_MAX_PORTFOLIO_CONFIG.assets) {
      expect(a.riskFrac).toBeCloseTo(0.33, 2);
    }
  });

  it("trigger and leverage correct", () => {
    expect(FTMO_MAX_PORTFOLIO_CONFIG.triggerBars).toBe(2);
    expect(FTMO_MAX_PORTFOLIO_CONFIG.leverage).toBe(2);
  });

  it("FTMO rules encoded", () => {
    expect(FTMO_MAX_PORTFOLIO_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_MAX_PORTFOLIO_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_MAX_PORTFOLIO_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_MAX_PORTFOLIO_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_MAX_PORTFOLIO_CONFIG.maxDays).toBe(30);
  });
});

describe("ftmoDaytradeMaxPortfolio — stats", () => {
  it("documents 100% OOS + 84 trades/day", () => {
    expect(FTMO_MAX_PORTFOLIO_STATS.tradesPerDay).toBeGreaterThan(80);
    expect(FTMO_MAX_PORTFOLIO_STATS.passRateOosOverlapping).toBeCloseTo(1.0, 2);
    expect(FTMO_MAX_PORTFOLIO_STATS.passRateNonOverlapping).toBeGreaterThan(
      0.95,
    );
  });

  it("EV strongly positive", () => {
    expect(FTMO_MAX_PORTFOLIO_STATS.evPerChallengeOos).toBeGreaterThan(3500);
    expect(FTMO_MAX_PORTFOLIO_STATS.evPerChallengeLive).toBeGreaterThan(3000);
  });

  it("iter179 metadata", () => {
    expect(FTMO_MAX_PORTFOLIO_STATS.iteration).toBe(179);
    expect(FTMO_MAX_PORTFOLIO_STATS.symbols.length).toBe(4);
  });

  it("per-asset solo pass rates documented", () => {
    const solo = FTMO_MAX_PORTFOLIO_STATS.perAssetSolo;
    expect(solo.BTCUSDT.oosPass).toBeGreaterThan(0.6);
    expect(solo.ETHUSDT.oosPass).toBeGreaterThan(0.75);
    expect(solo.SOLUSDT.oosPass).toBeGreaterThan(0.75);
    expect(solo.AVAXUSDT.oosPass).toBeGreaterThan(0.75);
  });

  it("20-challenge net ≥ $65k", () => {
    expect(
      FTMO_MAX_PORTFOLIO_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeGreaterThan(65_000);
  });
});

describe("ftmoDaytradeMaxPortfolio — runner", () => {
  it("handles empty gracefully", () => {
    const r = runFtmoMaxPortfolio({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("handles partial assets (missing SOL/AVAX)", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.01, 99.99, 100));
    const r = runFtmoMaxPortfolio({
      BTCUSDT: candles,
      ETHUSDT: candles,
    });
    expect(r.passed).toBe(false);
  });

  it("runs all 4 assets when provided", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const mkPattern = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + bar, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * bar, 99, 100.5, 99, 100.3));
      for (let i = 5; i < 30; i++)
        out.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
      return out;
    };
    const r = runFtmoMaxPortfolio({
      BTCUSDT: mkPattern(),
      ETHUSDT: mkPattern(),
      SOLUSDT: mkPattern(),
      AVAXUSDT: mkPattern(),
    });
    const uniqueSymbols = new Set(r.trades.map((t) => t.symbol));
    // At least 2 symbols should have generated trades
    expect(uniqueSymbols.size).toBeGreaterThanOrEqual(2);
  });
});
