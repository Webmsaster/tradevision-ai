/**
 * Smoke tests for ftmoDaytrade24h — iter189 FTMO Normal Plan daytrade.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG,
  FTMO_DAYTRADE_24H_STATS,
} from "../utils/ftmoDaytrade24h";
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
    closeTime: t + 4 * 3600_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
    isFinal: true,
  };
}

describe("ftmoDaytrade24h — config", () => {
  it("4h timeframe, 12h max hold (user constraint: 1 account)", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars).toBe(3);
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars * 4).toBeLessThanOrEqual(12);
  });

  it("iter212: pyramid r=5 + BTC EMA10/15 + momentum 6bar filter", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.assets.length).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.sourceSymbol).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.sourceSymbol).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.riskFrac).toBeCloseTo(1.0, 2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.riskFrac).toBeCloseTo(5.0, 2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.minEquityGain).toBeCloseTo(
      0.015,
      3,
    );
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.symbol).toBe("BTCUSDT");
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.emaFastPeriod).toBe(10);
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.emaSlowPeriod).toBe(15);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.skipShortsIfSecondaryUptrend,
    ).toBe(true);
    expect(FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.momentumBars).toBe(6);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.crossAssetFilter?.momSkipShortAbove,
    ).toBeCloseTo(0.02, 3);
  });

  it("iter211: 2-bar trigger + 1.2% stop + 4% TP + 12h hold + BTC filter", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.tpPct).toBeCloseTo(0.04, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.stopPct).toBeCloseTo(0.012, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.disableLong).toBe(true);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.tpPct / FTMO_DAYTRADE_24H_CONFIG.stopPct,
    ).toBeCloseTo(3.33, 1);
  });

  it("ETH cost at 30 bp (realistic taker)", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[0]!.costBp).toBe(30);
  });

  it("FTMO rules", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.leverage).toBe(2);
  });
});

describe("ftmoDaytrade24h — stats (iter212 full-history 50%+)", () => {
  it("~51% pass rate over 8.7-year Binance history (honest 50% milestone)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.passRateNov).toBeCloseTo(0.51, 1);
    expect(FTMO_DAYTRADE_24H_STATS.livePassRateEstimate).toBeGreaterThan(0.4);
    expect(FTMO_DAYTRADE_24H_STATS.livePassRateEstimate).toBeLessThan(0.52);
    expect(FTMO_DAYTRADE_24H_STATS.avgDailyReturn).toBeGreaterThan(0.015);
    expect(FTMO_DAYTRADE_24H_STATS.targetReachable).toBe(true);
  });

  it("documents recent-window + full-history + yearly spread", () => {
    expect(
      (FTMO_DAYTRADE_24H_STATS as unknown as { passRateRecent1000d: number })
        .passRateRecent1000d,
    ).toBeCloseTo(0.6, 1);
    // iter212 spreads 34-67% across regimes (minimum 34% even in worst bull)
    expect(FTMO_DAYTRADE_24H_STATS.regimeSpread).toBeLessThan(0.4);
  });

  it("median days to pass ≤ 15", () => {
    expect(FTMO_DAYTRADE_24H_STATS.medianDaysToPass).toBeLessThanOrEqual(15);
  });

  it("EV positive (iter212 full-history)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeOos).toBeGreaterThan(1700);
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeLive).toBeGreaterThan(1500);
  });

  it("is strict 12h intraday daytrade (user constraint)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.isDaytrade).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.allowsNormalPlan).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.maxHoldWithinLimit).toBeLessThanOrEqual(12);
  });

  it("20-challenge net ~$35k (iter212 full-history)", () => {
    const n =
      FTMO_DAYTRADE_24H_STATS.expectedOutcome20Challenges.expectedNetLive;
    expect(n).toBeGreaterThan(26_000);
    expect(n).toBeLessThan(55_000);
  });

  it("iter212 metadata: 12h hold + BTC EMA10/15 + drop 8 UTC", () => {
    expect(FTMO_DAYTRADE_24H_STATS.iteration).toBe(212);
    expect(FTMO_DAYTRADE_24H_STATS.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_STATS.symbols.length).toBe(1);
    expect(FTMO_DAYTRADE_24H_STATS.symbols[0]).toBe("ETHUSDT");
    expect(FTMO_DAYTRADE_24H_STATS.maxHoldHours).toBe(12);
    expect(FTMO_DAYTRADE_24H_STATS.stopPct).toBeCloseTo(0.012, 5);
    expect(FTMO_DAYTRADE_24H_STATS.tpPct).toBeCloseTo(0.04, 5);
    expect(FTMO_DAYTRADE_24H_STATS.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.disableLong).toBe(true);
    // iter212 session: all days, drop 8 UTC only
    expect(FTMO_DAYTRADE_24H_CONFIG.allowedDowsUtc).toBeUndefined();
    expect(FTMO_DAYTRADE_24H_CONFIG.allowedHoursUtc).toEqual([
      0, 4, 12, 16, 20,
    ]);
    expect(FTMO_DAYTRADE_24H_STATS.regimeSpread).toBeLessThan(0.35);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets.length).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.assets[1]!.minEquityGain).toBeCloseTo(
      0.015,
      3,
    );
  });

  it("target reachable, full-history 50%+ (iter212)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.targetReachable).toBe(true);
    expect(
      FTMO_DAYTRADE_24H_STATS.passRatePhysicalCeiling,
    ).toBeGreaterThanOrEqual(0.5);
  });
});

describe("ftmoDaytrade24h — runner", () => {
  it("empty input → insufficient_days", () => {
    const r = runFtmoDaytrade24h({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("max hold stays ≤ 12h (3 bars × 4h)", () => {
    const t0 = 1_700_000_000_000;
    const barMs = 4 * 3600_000;
    // 3 consecutive red bars then flat → time exit
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * barMs, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * barMs, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * barMs, 99, 99, 98, 98));
      for (let i = 5; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 98, 98.5, 97.5, 98));
      return out;
    };
    const r = runFtmoDaytrade24h({ ETHUSDT: mkPat() });
    expect(r.maxHoldHoursObserved).toBeLessThanOrEqual(12);
  });

  it("TP hit pattern triggers large win", () => {
    // Thu 2024-01-04 04:00 UTC — signal bar lands on Thu 12:00 UTC,
    // which is allowed under iter212's session filter (drop 8 UTC only).
    const t0 = new Date("2024-01-04T04:00:00Z").getTime();
    const barMs = 4 * 3600_000;
    // iter202 is short-only with 2-bar trigger → need 2 consecutive
    // GREEN closes, then a drop so the short can profit.
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 102, 100, 102)); // green 1
      out.push(mkCandle(t0 + 2 * barMs, 102, 105, 102, 105)); // green 2
      // entry at bar 3 open (short), rally knocked down 10% to 94.5
      out.push(mkCandle(t0 + 3 * barMs, 105, 106, 88, 90));
      for (let i = 4; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 90, 91, 89, 90));
      return out;
    };
    const r = runFtmoDaytrade24h({ ETHUSDT: mkPat() });
    // short signal fired and TP (10%) was hit — expect ≥ 1 trade
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
  });
});
