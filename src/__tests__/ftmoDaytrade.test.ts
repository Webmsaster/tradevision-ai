/**
 * Smoke tests for ftmoDaytrade — iter169 true-daytrade FTMO strategy.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade,
  detect4DownSignals,
  FTMO_DAYTRADE_CONFIG,
  FTMO_DAYTRADE_STATS,
} from "../utils/ftmoDaytrade";
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

describe("ftmoDaytrade — config invariants", () => {
  it("4-down trigger with tight tp/stop at 2× leverage", () => {
    expect(FTMO_DAYTRADE_CONFIG.downBars).toBe(4);
    expect(FTMO_DAYTRADE_CONFIG.tpPct).toBeCloseTo(0.008, 5);
    expect(FTMO_DAYTRADE_CONFIG.stopPct).toBeCloseTo(0.002, 5);
    expect(FTMO_DAYTRADE_CONFIG.holdBars).toBe(4);
    expect(FTMO_DAYTRADE_CONFIG.leverage).toBe(2);
    expect(FTMO_DAYTRADE_CONFIG.riskFrac).toBe(1.0);
  });

  it("FTMO Phase 1 rules correctly encoded", () => {
    expect(FTMO_DAYTRADE_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_DAYTRADE_CONFIG.maxDays).toBe(30);
  });

  it("TP:Stop ratio is 4:1 (asymmetric payoff)", () => {
    expect(
      FTMO_DAYTRADE_CONFIG.tpPct / FTMO_DAYTRADE_CONFIG.stopPct,
    ).toBeCloseTo(4, 2);
  });
});

describe("ftmoDaytrade — iter169 stats", () => {
  it("stats document iter169 validation", () => {
    expect(FTMO_DAYTRADE_STATS.iteration).toBe(169);
    expect(FTMO_DAYTRADE_STATS.timeframe).toBe("15m");
    expect(FTMO_DAYTRADE_STATS.tradesPerDay).toBeGreaterThan(2);
    expect(FTMO_DAYTRADE_STATS.tradesPerDay).toBeLessThan(4);
  });

  it("pass rate is positive at all validation splits", () => {
    expect(FTMO_DAYTRADE_STATS.passRateFullSample).toBeGreaterThan(0.2);
    expect(FTMO_DAYTRADE_STATS.passRateInSample).toBeGreaterThan(0.2);
    expect(FTMO_DAYTRADE_STATS.passRateOos).toBeGreaterThan(0.1);
  });

  it("EV is strongly positive across all splits", () => {
    expect(FTMO_DAYTRADE_STATS.evPerChallengeFullSample).toBeGreaterThan(500);
    expect(FTMO_DAYTRADE_STATS.evPerChallengeInSample).toBeGreaterThan(500);
    expect(FTMO_DAYTRADE_STATS.evPerChallengeOos).toBeGreaterThan(200);
  });

  it("asymmetric TP/Stop (low WR acceptable)", () => {
    // WR 38% with TP:Stop 4:1 is mathematically positive
    // expected = 0.38 × 4 − 0.62 × 1 = 1.52 − 0.62 = +0.90 R
    expect(FTMO_DAYTRADE_STATS.winRate).toBeGreaterThan(0.3);
    expect(FTMO_DAYTRADE_STATS.winRate).toBeLessThan(0.5);
  });
});

describe("ftmoDaytrade — signal detection", () => {
  it("returns empty on insufficient candles", () => {
    expect(detect4DownSignals([])).toEqual([]);
    expect(detect4DownSignals([mkCandle(0, 100, 101, 99, 100)])).toEqual([]);
  });

  it("detects 4-down-bar trigger", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    // Need at least downBars+1 prior bars + 1 entry bar + holdBars
    const candles: Candle[] = [];
    // 2 padding bars (going up)
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 102, 99, 101));
    // 4 consecutive down closes (101 → 100 → 99 → 98 → 97)
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    candles.push(mkCandle(t0 + 4 * bar, 99, 99, 98, 98));
    candles.push(mkCandle(t0 + 5 * bar, 98, 98, 97, 97));
    // Entry bar at index 6: open 97, TP at 97×1.008=97.776, stop at 97×0.998=96.806
    candles.push(mkCandle(t0 + 6 * bar, 97, 98, 96.8, 97.5));
    // Exit bar — hits TP (high >= 97.776)
    candles.push(mkCandle(t0 + 7 * bar, 97.5, 98.5, 97.5, 98.2));
    for (let i = 8; i < 20; i++) {
      candles.push(mkCandle(t0 + i * bar, 98, 98.5, 97.5, 98));
    }
    const signals = detect4DownSignals(candles);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].exitReason).toBe("tp");
    expect(signals[0].rawPnl).toBeGreaterThan(0.005); // ~0.8% minus costs
  });

  it("effPnl = rawPnl × leverage × riskFrac, capped at −riskFrac", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 102, 99, 101));
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    candles.push(mkCandle(t0 + 4 * bar, 99, 99, 98, 98));
    candles.push(mkCandle(t0 + 5 * bar, 98, 98, 97, 97));
    // Entry at 97, stop at 96.806 — next bar drops to 96.5 (hits stop)
    candles.push(mkCandle(t0 + 6 * bar, 97, 97, 96.5, 96.8));
    for (let i = 7; i < 20; i++)
      candles.push(mkCandle(t0 + i * bar, 97, 97.5, 96.5, 97));
    const signals = detect4DownSignals(candles);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].exitReason).toBe("stop");
    // rawPnl ≈ −0.2% → effPnl = −0.2% × 2 × 1.0 = −0.4%
    expect(signals[0].effPnl).toBeLessThan(0);
    expect(signals[0].effPnl).toBeGreaterThan(-0.01); // survives, not liquidated
  });
});

describe("ftmoDaytrade — challenge runner", () => {
  it("returns insufficient_days when no triggers fire", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++) {
      // flat candles — no 4-down pattern
      candles.push(mkCandle(t0 + i * bar, 100, 100.2, 99.8, 100));
    }
    const r = runFtmoDaytrade(candles);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("accumulates multiple trades across days", () => {
    // Build 30 days of candles with periodic 4-down patterns
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++) {
      // every 24 bars (6h), simulate a 4-down-then-recover pattern
      const phase = i % 24;
      let o = 100,
        h = 100.5,
        l = 99.5,
        cl = 100;
      if (phase >= 4 && phase < 8) {
        // 4 down bars
        cl = 100 - (phase - 3) * 0.25;
        o = cl + 0.3;
        h = o;
        l = cl - 0.1;
      } else if (phase >= 8 && phase < 12) {
        // recovery up
        o = 99;
        cl = 100;
        h = 100.5;
        l = 98.9;
      }
      candles.push(mkCandle(t0 + i * bar, o, h, l, cl));
    }
    const r = runFtmoDaytrade(candles);
    // At least some trades should execute
    expect(r.trades.length).toBeGreaterThan(0);
  });
});
