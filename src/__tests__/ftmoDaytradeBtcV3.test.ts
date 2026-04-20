/**
 * Smoke tests for ftmoDaytradeBtcV3 — iter177 BTC V3 (tight stop).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytradeBtcV3,
  detectBtcV3LongSignals,
  detectBtcV3ShortSignals,
  FTMO_DAYTRADE_BTC_V3_CONFIG,
  FTMO_DAYTRADE_BTC_V3_STATS,
} from "../utils/ftmoDaytradeBtcV3";
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

describe("ftmoDaytradeBtcV3 — config", () => {
  it("V3 uses tight 0.1% stop + 1.2% TP + 80% risk", () => {
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.tpPct).toBeCloseTo(0.012, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.stopPct).toBeCloseTo(0.001, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.holdBars).toBe(12);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.riskFrac).toBeCloseTo(0.8, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.leverage).toBe(2);
  });

  it("TP:Stop ratio is 12:1", () => {
    const ratio =
      FTMO_DAYTRADE_BTC_V3_CONFIG.tpPct / FTMO_DAYTRADE_BTC_V3_CONFIG.stopPct;
    expect(ratio).toBeCloseTo(12, 1);
  });

  it("FTMO Phase 1 rules correct", () => {
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_DAYTRADE_BTC_V3_CONFIG.maxDays).toBe(30);
  });
});

describe("ftmoDaytradeBtcV3 — stats", () => {
  it("validated pass rates ≥ 65% across methods", () => {
    expect(FTMO_DAYTRADE_BTC_V3_STATS.passRateNonOverlapping).toBeGreaterThan(
      0.75,
    );
    expect(FTMO_DAYTRADE_BTC_V3_STATS.passRateOos).toBeGreaterThan(0.7);
    expect(FTMO_DAYTRADE_BTC_V3_STATS.passRateMonteCarlo70pct).toBeGreaterThan(
      0.65,
    );
    expect(FTMO_DAYTRADE_BTC_V3_STATS.livePassRateEstimate).toBeCloseTo(
      0.65,
      2,
    );
  });

  it("EV positive across all scenarios", () => {
    expect(FTMO_DAYTRADE_BTC_V3_STATS.evPerChallengeOos).toBeGreaterThan(2000);
    expect(FTMO_DAYTRADE_BTC_V3_STATS.evPerChallengeLive).toBeGreaterThan(2000);
  });

  it("iter177 metadata correct", () => {
    expect(FTMO_DAYTRADE_BTC_V3_STATS.iteration).toBe(177);
    expect(FTMO_DAYTRADE_BTC_V3_STATS.symbol).toBe("BTCUSDT");
    expect(FTMO_DAYTRADE_BTC_V3_STATS.timeframe).toBe("15m");
  });

  it("slippage sensitivity documented", () => {
    expect(
      FTMO_DAYTRADE_BTC_V3_STATS.slippageSensitivity["0%"],
    ).toBeGreaterThan(0.75);
    expect(
      FTMO_DAYTRADE_BTC_V3_STATS.slippageSensitivity["0.05%"],
    ).toBeGreaterThan(0.5);
  });

  it("20-challenge net profit ≥ $40k", () => {
    expect(
      FTMO_DAYTRADE_BTC_V3_STATS.expectedOutcome20Challenges.expectedNetLive,
    ).toBeGreaterThan(40_000);
  });
});

describe("ftmoDaytradeBtcV3 — signals", () => {
  it("long fires on 2-down", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 101));
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    // Entry 99, TP 99×1.012=100.19, stop 99×0.999=98.901
    candles.push(mkCandle(t0 + 4 * bar, 99, 100.5, 99, 100.3));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
    const sigs = detectBtcV3LongSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0].direction).toBe("long");
  });

  it("short fires on 2-up", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 99));
    candles.push(mkCandle(t0 + 2 * bar, 99, 100, 99, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 101, 100, 101));
    candles.push(mkCandle(t0 + 4 * bar, 101, 101, 99.5, 99.7));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 99.5, 100, 99, 99.5));
    const sigs = detectBtcV3ShortSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0].direction).toBe("short");
  });

  it("effPnl scales with 80% risk × 2× leverage", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 101));
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    candles.push(mkCandle(t0 + 4 * bar, 99, 100.5, 99, 100.3));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
    const sigs = detectBtcV3LongSignals(candles);
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    const ratio = sigs[0].effPnl / sigs[0].rawPnl;
    expect(ratio).toBeCloseTo(1.6, 1); // 2 × 0.8 = 1.6
  });
});

describe("ftmoDaytradeBtcV3 — runner", () => {
  it("insufficient_days on flat market", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.01, 99.99, 100));
    const r = runFtmoDaytradeBtcV3(candles);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });
});
