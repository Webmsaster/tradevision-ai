/**
 * Smoke tests for ftmoDaytradeV2 — iter172 flagship FTMO strategy.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytradeV2,
  detectNDownLongSignals,
  detectNUpShortSignals,
  FTMO_DAYTRADE_V2_CONFIG,
  FTMO_DAYTRADE_V2_STATS,
} from "../utils/ftmoDaytradeV2";
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

describe("ftmoDaytradeV2 — config invariants", () => {
  it("bidirectional 2-bar trigger with 1% TP / 0.15% stop", () => {
    expect(FTMO_DAYTRADE_V2_CONFIG.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_V2_CONFIG.tpPct).toBeCloseTo(0.01, 5);
    expect(FTMO_DAYTRADE_V2_CONFIG.stopPct).toBeCloseTo(0.0015, 5);
    expect(FTMO_DAYTRADE_V2_CONFIG.holdBars).toBe(12);
    expect(FTMO_DAYTRADE_V2_CONFIG.leverage).toBe(2);
    expect(FTMO_DAYTRADE_V2_CONFIG.riskFrac).toBe(1.0);
    expect(FTMO_DAYTRADE_V2_CONFIG.enableLong).toBe(true);
    expect(FTMO_DAYTRADE_V2_CONFIG.enableShort).toBe(true);
  });

  it("FTMO Phase 1 rules correctly encoded", () => {
    expect(FTMO_DAYTRADE_V2_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_V2_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_V2_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_V2_CONFIG.minTradingDays).toBe(4);
    expect(FTMO_DAYTRADE_V2_CONFIG.maxDays).toBe(30);
  });

  it("asymmetric 6.67:1 TP/Stop ratio", () => {
    const ratio =
      FTMO_DAYTRADE_V2_CONFIG.tpPct / FTMO_DAYTRADE_V2_CONFIG.stopPct;
    expect(ratio).toBeCloseTo(6.67, 1);
  });
});

describe("ftmoDaytradeV2 — iter172 stats", () => {
  it("documents flagship numbers", () => {
    expect(FTMO_DAYTRADE_V2_STATS.iteration).toBe(172);
    expect(FTMO_DAYTRADE_V2_STATS.version).toBe("v2");
    expect(FTMO_DAYTRADE_V2_STATS.bothDirections).toBe(true);
  });

  it("pass rates strongly positive at all splits", () => {
    expect(FTMO_DAYTRADE_V2_STATS.passRateFullSample).toBeGreaterThan(0.5);
    expect(FTMO_DAYTRADE_V2_STATS.passRateInSample).toBeGreaterThan(0.55);
    expect(FTMO_DAYTRADE_V2_STATS.passRateOos).toBeGreaterThan(0.5);
  });

  it("EV exceeds $2k at all splits", () => {
    expect(FTMO_DAYTRADE_V2_STATS.evPerChallengeFullSample).toBeGreaterThan(
      2000,
    );
    expect(FTMO_DAYTRADE_V2_STATS.evPerChallengeOos).toBeGreaterThan(2000);
  });

  it("IS/OOS gap is small (robust)", () => {
    // 5.75pp gap — best robustness among shipped strategies
    expect(Math.abs(FTMO_DAYTRADE_V2_STATS.isOosGap)).toBeLessThan(0.1);
  });

  it("expected outcome over 20 challenges is strongly positive", () => {
    expect(
      FTMO_DAYTRADE_V2_STATS.expectedOutcome20Challenges.expectedNetProfit,
    ).toBeGreaterThan(30_000);
  });
});

describe("ftmoDaytradeV2 — signal detection", () => {
  it("empty on insufficient candles", () => {
    expect(detectNDownLongSignals([])).toEqual([]);
    expect(detectNUpShortSignals([])).toEqual([]);
  });

  it("2-down trigger fires on 2 consecutive red bars", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    // padding
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 101));
    // 2 consecutive down closes (101 → 100 → 99)
    candles.push(mkCandle(t0 + 2 * bar, 101, 101, 100, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 100, 99, 99));
    // Entry bar: open 99 → TP at 99×1.01 = 99.99, stop at 99×0.9985 = 98.85
    candles.push(mkCandle(t0 + 4 * bar, 99, 100.5, 99, 100.2));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 100, 100.5, 99.5, 100));
    const signals = detectNDownLongSignals(candles);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].direction).toBe("long");
    expect(signals[0].exitReason).toBe("tp");
  });

  it("2-up trigger fires on 2 consecutive green bars (short)", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    candles.push(mkCandle(t0, 100, 101, 99, 100));
    candles.push(mkCandle(t0 + bar, 100, 101, 99, 99));
    // 2 consecutive up closes (99 → 100 → 101)
    candles.push(mkCandle(t0 + 2 * bar, 99, 100, 99, 100));
    candles.push(mkCandle(t0 + 3 * bar, 100, 101, 100, 101));
    // Entry bar: open 101, short TP at 99.99 (−1%), stop at 101.15 (+0.15%)
    candles.push(mkCandle(t0 + 4 * bar, 101, 101, 99, 99.5));
    for (let i = 5; i < 30; i++)
      candles.push(mkCandle(t0 + i * bar, 99.5, 100, 99, 99.5));
    const signals = detectNUpShortSignals(candles);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].direction).toBe("short");
    expect(signals[0].exitReason).toBe("tp");
  });
});

describe("ftmoDaytradeV2 — challenge runner", () => {
  it("returns insufficient_days on flat market", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < 30 * 96; i++) {
      candles.push(mkCandle(t0 + i * bar, 100, 100.01, 99.99, 100));
    }
    const r = runFtmoDaytradeV2(candles);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("long-only mode excludes shorts", () => {
    const t0 = 1_700_000_000_000;
    const bar = 15 * 60_000;
    const candles: Candle[] = [];
    // alternating patterns
    for (let i = 0; i < 100; i++) {
      const o = 100 + (i % 4) - 1;
      const c = 100 + (i % 4) - 2;
      candles.push(mkCandle(t0 + i * bar, o, o + 0.5, c - 0.5, c));
    }
    const r = runFtmoDaytradeV2(candles, {
      ...FTMO_DAYTRADE_V2_CONFIG,
      enableShort: false,
    });
    for (const t of r.trades) expect(t.direction).toBe("long");
  });
});
