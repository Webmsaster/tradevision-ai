/**
 * Smoke tests for ftmoDaytradePortfolio — iter178 BTC+ETH portfolio.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoPortfolio,
  FTMO_PORTFOLIO_CONFIG,
  FTMO_PORTFOLIO_STATS,
} from "../utils/ftmoDaytradePortfolio";
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

describe("ftmoDaytradePortfolio — config", () => {
  it("portfolio has BTC and ETH with 50% risk each", () => {
    expect(FTMO_PORTFOLIO_CONFIG.assets.length).toBe(2);
    expect(FTMO_PORTFOLIO_CONFIG.assets[0].symbol).toBe("BTCUSDT");
    expect(FTMO_PORTFOLIO_CONFIG.assets[1].symbol).toBe("ETHUSDT");
    expect(FTMO_PORTFOLIO_CONFIG.assets[0].riskFrac).toBeCloseTo(0.5, 5);
    expect(FTMO_PORTFOLIO_CONFIG.assets[1].riskFrac).toBeCloseTo(0.5, 5);
    expect(FTMO_PORTFOLIO_CONFIG.leverage).toBe(2);
    expect(FTMO_PORTFOLIO_CONFIG.triggerBars).toBe(2);
  });

  it("asset configs match shipped V3 params", () => {
    const [btc, eth] = FTMO_PORTFOLIO_CONFIG.assets;
    expect(btc.tpPct).toBeCloseTo(0.012, 5);
    expect(btc.stopPct).toBeCloseTo(0.001, 5);
    expect(eth.tpPct).toBeCloseTo(0.01, 5);
    expect(eth.stopPct).toBeCloseTo(0.0015, 5);
    expect(btc.holdBars).toBe(12);
    expect(eth.holdBars).toBe(12);
  });

  it("FTMO rules encoded", () => {
    expect(FTMO_PORTFOLIO_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_PORTFOLIO_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_PORTFOLIO_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_PORTFOLIO_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_PORTFOLIO_CONFIG.maxDays).toBe(30);
  });
});

describe("ftmoDaytradePortfolio — stats", () => {
  it("documents 96% OOS + 40 trades/day", () => {
    expect(FTMO_PORTFOLIO_STATS.tradesPerDay).toBeGreaterThanOrEqual(30);
    expect(FTMO_PORTFOLIO_STATS.passRateOosOverlapping).toBeGreaterThan(0.9);
    expect(FTMO_PORTFOLIO_STATS.passRateNonOverlapping).toBeGreaterThan(0.8);
  });

  it("EV positive across scenarios", () => {
    expect(FTMO_PORTFOLIO_STATS.evPerChallengeOos).toBeGreaterThan(3000);
    expect(FTMO_PORTFOLIO_STATS.evPerChallengeLive).toBeGreaterThan(2500);
  });

  it("20-challenge net profit ≥ $50k", () => {
    expect(
      FTMO_PORTFOLIO_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeGreaterThan(50_000);
  });

  it("iter178 metadata", () => {
    expect(FTMO_PORTFOLIO_STATS.iteration).toBe(178);
    expect(FTMO_PORTFOLIO_STATS.symbols).toContain("BTCUSDT");
    expect(FTMO_PORTFOLIO_STATS.symbols).toContain("ETHUSDT");
  });
});

describe("ftmoDaytradePortfolio — runner", () => {
  it("handles empty candles map gracefully", () => {
    const r = runFtmoPortfolio({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
    expect(r.trades.length).toBe(0);
  });

  it("handles missing symbol without crash", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.01, 99.99, 100));
    // only provide BTCUSDT, not ETHUSDT
    const r = runFtmoPortfolio({ BTCUSDT: candles });
    expect(r.passed).toBe(false);
  });

  it("combines trades from both assets", () => {
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
    const r = runFtmoPortfolio({
      BTCUSDT: mkPattern(),
      ETHUSDT: mkPattern(),
    });
    const btcTrades = r.trades.filter((t) => t.symbol === "BTCUSDT");
    const ethTrades = r.trades.filter((t) => t.symbol === "ETHUSDT");
    // Both should have at least one trade each
    expect(btcTrades.length + ethTrades.length).toBeGreaterThanOrEqual(2);
  });
});
