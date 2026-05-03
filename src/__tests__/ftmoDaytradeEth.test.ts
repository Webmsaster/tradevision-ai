/**
 * Smoke tests for ftmoDaytradeEth — iter175 FLAGSHIP strategy.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytradeEth,
  detectEthLongSignals,
  detectEthShortSignals,
  FTMO_DAYTRADE_ETH_CONFIG,
  FTMO_DAYTRADE_ETH_STATS,
} from "../utils/ftmoDaytradeEth";
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

describe("ftmoDaytradeEth — config", () => {
  it("flagship ETH config uses 60% risk + bidirectional", () => {
    expect(FTMO_DAYTRADE_ETH_CONFIG.riskFrac).toBeCloseTo(0.6, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.enableLong).toBe(true);
    expect(FTMO_DAYTRADE_ETH_CONFIG.enableShort).toBe(true);
    expect(FTMO_DAYTRADE_ETH_CONFIG.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_ETH_CONFIG.tpPct).toBeCloseTo(0.01, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.stopPct).toBeCloseTo(0.0015, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.holdBars).toBe(12);
    expect(FTMO_DAYTRADE_ETH_CONFIG.leverage).toBe(2);
  });

  it("FTMO Phase 1 rules encoded correctly", () => {
    expect(FTMO_DAYTRADE_ETH_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_ETH_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_DAYTRADE_ETH_CONFIG.maxDays).toBe(30);
  });
});

describe("ftmoDaytradeEth — stats", () => {
  it("sanity-validated pass rates ≥ 75%", () => {
    expect(FTMO_DAYTRADE_ETH_STATS.passRateNonOverlapping).toBeGreaterThan(
      0.75,
    );
    expect(FTMO_DAYTRADE_ETH_STATS.passRateMonteCarlo).toBeGreaterThan(0.75);
    expect(FTMO_DAYTRADE_ETH_STATS.livePassRateEstimate).toBeCloseTo(0.75, 2);
  });

  it("EV strongly positive in both conservative and MC scenarios", () => {
    expect(FTMO_DAYTRADE_ETH_STATS.evPerChallengeConservative).toBeGreaterThan(
      2500,
    );
    expect(FTMO_DAYTRADE_ETH_STATS.evPerChallengeMonteCarlo).toBeGreaterThan(
      3000,
    );
  });

  it("documents iter175 and asset/timeframe", () => {
    expect(FTMO_DAYTRADE_ETH_STATS.iteration).toBe(175);
    expect(FTMO_DAYTRADE_ETH_STATS.symbol).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_ETH_STATS.timeframe).toBe("15m");
    expect(FTMO_DAYTRADE_ETH_STATS.version).toBe("v3-flagship");
  });

  it("expected 20-challenge profit ≥ $50k", () => {
    expect(
      FTMO_DAYTRADE_ETH_STATS.expectedOutcome20Challenges
        .expectedNetConservative,
    ).toBeGreaterThan(50_000);
  });
});

describe("ftmoDaytradeEth — signal detection", () => {
  it("empty on insufficient candles", () => {
    expect(detectEthLongSignals([])).toEqual([]);
    expect(detectEthShortSignals([])).toEqual([]);
  });

  it("long fires on 2 consecutive red bars", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 101));
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    // entry open 99, TP at 99×1.01, stop at 99×0.9985
    candles.push(mkCandle(t0 + 4 * bar, 99, 100.3, 99, 100.2));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
    const sigs = detectEthLongSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0]!.direction).toBe("long");
  });

  it("short fires on 2 consecutive green bars", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 99));
    candles.push(mkCandle(t0 + 2 * bar, 99, 100, 99, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 101, 100, 101));
    // entry open 101, short
    candles.push(mkCandle(t0 + 4 * bar, 101, 101, 99.5, 99.6));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 99.5, 100, 99, 99.5));
    const sigs = detectEthShortSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0]!.direction).toBe("short");
  });
});

describe("ftmoDaytradeEth — runner", () => {
  it("insufficient_days on flat market", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.01, 99.99, 100));
    const r = runFtmoDaytradeEth(candles);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("effPnl scales with 60% risk frac", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 101));
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    candles.push(mkCandle(t0 + 4 * bar, 99, 100.3, 99, 100.2));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
    const sigs = detectEthLongSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    const s = sigs[0];
    // effPnl ≈ rawPnl × 2 × 0.6 = rawPnl × 1.2
    const ratio = s!.effPnl / s!.rawPnl;
    expect(ratio).toBeCloseTo(1.2, 1);
  });
});
