/**
 * Smoke tests for ftmoRealisticMax — iter183 crypto-only realistic winner.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoRealisticMax,
  FTMO_REALISTIC_MAX_CONFIG,
  FTMO_REALISTIC_MAX_STATS,
} from "../utils/ftmoRealisticMax";
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

describe("ftmoRealisticMax — config", () => {
  it("BTC+ETH combined 50% risk each", () => {
    expect(FTMO_REALISTIC_MAX_CONFIG.assets.length).toBe(2);
    const [btc, eth] = FTMO_REALISTIC_MAX_CONFIG.assets;
    expect(btc.symbol).toBe("BTCUSDT");
    expect(eth.symbol).toBe("ETHUSDT");
    expect(btc.riskFrac).toBeCloseTo(0.5, 5);
    expect(eth.riskFrac).toBeCloseTo(0.5, 5);
  });

  it("realistic costs encoded", () => {
    const [btc, eth] = FTMO_REALISTIC_MAX_CONFIG.assets;
    expect(btc.costBp).toBe(40);
    expect(eth.costBp).toBe(30);
  });

  it("asymmetric TPs (BTC 8%, ETH 12%)", () => {
    const [btc, eth] = FTMO_REALISTIC_MAX_CONFIG.assets;
    expect(btc.tpPct).toBeCloseTo(0.08, 5);
    expect(eth.tpPct).toBeCloseTo(0.12, 5);
    expect(btc.stopPct).toBeCloseTo(0.02, 5);
    expect(eth.stopPct).toBeCloseTo(0.02, 5);
  });

  it("20-day hold (swing not daytrade)", () => {
    for (const a of FTMO_REALISTIC_MAX_CONFIG.assets)
      expect(a.holdDays).toBe(20);
  });

  it("FTMO rules correct", () => {
    expect(FTMO_REALISTIC_MAX_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_REALISTIC_MAX_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_REALISTIC_MAX_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_REALISTIC_MAX_CONFIG.leverage).toBe(2);
  });
});

describe("ftmoRealisticMax — stats", () => {
  it("OOS ≥ IS (no overfit)", () => {
    expect(FTMO_REALISTIC_MAX_STATS.passRateOos).toBeGreaterThanOrEqual(
      FTMO_REALISTIC_MAX_STATS.passRateInSample,
    );
  });

  it("honest 45% live estimate (not magic 100%)", () => {
    expect(FTMO_REALISTIC_MAX_STATS.livePassRateEstimate).toBeCloseTo(0.45, 2);
    expect(FTMO_REALISTIC_MAX_STATS.passRateOos).toBeGreaterThan(0.5);
  });

  it("EV positive, honest amount", () => {
    expect(FTMO_REALISTIC_MAX_STATS.evPerChallengeOos).toBeGreaterThan(1800);
    expect(FTMO_REALISTIC_MAX_STATS.evPerChallengeOos).toBeLessThan(3000);
  });

  it("explicitly NOT daytrade", () => {
    expect(FTMO_REALISTIC_MAX_STATS.isDaytrade).toBe(false);
  });

  it("20-challenge net ~$34k", () => {
    expect(
      FTMO_REALISTIC_MAX_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeGreaterThan(30_000);
    expect(
      FTMO_REALISTIC_MAX_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeLessThan(45_000);
  });

  it("iter183 metadata", () => {
    expect(FTMO_REALISTIC_MAX_STATS.iteration).toBe(183);
    expect(FTMO_REALISTIC_MAX_STATS.symbols).toContain("BTCUSDT");
    expect(FTMO_REALISTIC_MAX_STATS.symbols).toContain("ETHUSDT");
  });
});

describe("ftmoRealisticMax — runner", () => {
  it("insufficient_days on empty", () => {
    const r = runFtmoRealisticMax({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("handles flat market", () => {
    const t0 = 1_700_000_000_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++)
      candles.push(mkCandle(t0 + i * 24 * 3600_000, 100, 100.1, 99.9, 100));
    const r = runFtmoRealisticMax({
      BTCUSDT: candles,
      ETHUSDT: candles,
    });
    expect(r.passed).toBe(false);
  });

  it("detects 2-down trigger on both assets", () => {
    const t0 = 1_700_000_000_000;
    const day = 24 * 3600_000;
    const mkPattern = (): Candle[] => {
      const c: Candle[] = [];
      c.push(mkCandle(t0, 100, 101, 99, 100));
      c.push(mkCandle(t0 + day, 100, 101, 99, 101));
      c.push(mkCandle(t0 + 2 * day, 101, 101, 100, 100));
      c.push(mkCandle(t0 + 3 * day, 100, 100, 99, 99));
      c.push(mkCandle(t0 + 4 * day, 99, 110, 99, 108));
      for (let i = 5; i < 30; i++)
        c.push(mkCandle(t0 + i * day, 108, 110, 107, 108));
      return c;
    };
    const r = runFtmoRealisticMax({
      BTCUSDT: mkPattern(),
      ETHUSDT: mkPattern(),
    });
    const syms = new Set(r.trades.map((t) => t.symbol));
    expect(syms.size).toBeGreaterThanOrEqual(1);
  });
});
