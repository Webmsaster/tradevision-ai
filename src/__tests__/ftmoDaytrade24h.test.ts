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
  it("4h timeframe, 16h max hold ≤ 24h", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars).toBe(4);
    expect(FTMO_DAYTRADE_24H_CONFIG.holdBars * 4).toBeLessThanOrEqual(24);
  });

  it("3 assets (BTC+ETH+SOL) at 40% risk each", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.assets.length).toBe(3);
    const syms = FTMO_DAYTRADE_24H_CONFIG.assets.map((a) => a.symbol);
    expect(syms).toContain("BTCUSDT");
    expect(syms).toContain("ETHUSDT");
    expect(syms).toContain("SOLUSDT");
    expect(syms).not.toContain("AVAXUSDT");
    for (const a of FTMO_DAYTRADE_24H_CONFIG.assets) {
      expect(a.riskFrac).toBeCloseTo(0.4, 2);
    }
  });

  it("2-bar trigger + asymmetric 16:1 TP/Stop", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.triggerBars).toBe(2);
    expect(FTMO_DAYTRADE_24H_CONFIG.tpPct).toBeCloseTo(0.08, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.stopPct).toBeCloseTo(0.005, 5);
    expect(
      FTMO_DAYTRADE_24H_CONFIG.tpPct / FTMO_DAYTRADE_24H_CONFIG.stopPct,
    ).toBeCloseTo(16, 1);
  });

  it("realistic per-asset costs", () => {
    const map: Record<string, number> = {};
    for (const a of FTMO_DAYTRADE_24H_CONFIG.assets) map[a.symbol] = a.costBp;
    expect(map.BTCUSDT).toBe(40);
    expect(map.ETHUSDT).toBe(30);
    expect(map.SOLUSDT).toBe(40);
  });

  it("FTMO rules", () => {
    expect(FTMO_DAYTRADE_24H_CONFIG.profitTarget).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxDailyLoss).toBeCloseTo(0.05, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.maxTotalLoss).toBeCloseTo(0.1, 5);
    expect(FTMO_DAYTRADE_24H_CONFIG.leverage).toBe(2);
  });
});

describe("ftmoDaytrade24h — stats", () => {
  it("honest ~50% pass rate (NOT 100%)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.passRateNov).toBeCloseTo(0.52, 1);
    expect(FTMO_DAYTRADE_24H_STATS.livePassRateEstimate).toBeCloseTo(0.5, 2);
    expect(FTMO_DAYTRADE_24H_STATS.avgDailyReturn).toBeGreaterThan(0.01);
  });

  it("median days to pass ≤ 10", () => {
    expect(FTMO_DAYTRADE_24H_STATS.medianDaysToPass).toBeLessThanOrEqual(10);
  });

  it("EV positive", () => {
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeOos).toBeGreaterThan(1800);
    expect(FTMO_DAYTRADE_24H_STATS.evPerChallengeLive).toBeGreaterThan(1800);
  });

  it("is TRUE daytrade (≤ 24h)", () => {
    expect(FTMO_DAYTRADE_24H_STATS.isDaytrade).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.allowsNormalPlan).toBe(true);
    expect(FTMO_DAYTRADE_24H_STATS.maxHoldWithinLimit).toBeLessThanOrEqual(24);
  });

  it("20-challenge net ~$38k", () => {
    const n =
      FTMO_DAYTRADE_24H_STATS.expectedOutcome20Challenges.expectedNetLive;
    expect(n).toBeGreaterThan(32_000);
    expect(n).toBeLessThan(50_000);
  });

  it("iter194 metadata + compound sizing", () => {
    expect(FTMO_DAYTRADE_24H_STATS.iteration).toBe(194);
    expect(FTMO_DAYTRADE_24H_STATS.timeframe).toBe("4h");
    expect(FTMO_DAYTRADE_24H_STATS.symbols.length).toBe(3);
    expect(FTMO_DAYTRADE_24H_STATS.adaptiveSizing).toBe(true);
    expect(FTMO_DAYTRADE_24H_CONFIG.adaptiveSizing).toBeDefined();
    expect(FTMO_DAYTRADE_24H_CONFIG.adaptiveSizing!.length).toBe(3);
  });
});

describe("ftmoDaytrade24h — runner", () => {
  it("empty input → insufficient_days", () => {
    const r = runFtmoDaytrade24h({});
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_days");
  });

  it("max hold stays ≤ 16h (4 bars × 4h)", () => {
    const t0 = 1_700_000_000_000;
    const barMs = 4 * 3600_000;
    // 3 consecutive red bars then flat → time exit at bar 4
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * barMs, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * barMs, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * barMs, 99, 99, 98, 98));
      // 4 hold bars after entry
      for (let i = 5; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 98, 98.5, 97.5, 98));
      return out;
    };
    const r = runFtmoDaytrade24h({
      BTCUSDT: mkPat(),
      ETHUSDT: mkPat(),
      SOLUSDT: mkPat(),
    });
    expect(r.maxHoldHoursObserved).toBeLessThanOrEqual(16);
  });

  it("TP hit pattern triggers large win", () => {
    const t0 = 1_700_000_000_000;
    const barMs = 4 * 3600_000;
    const mkPat = (): Candle[] => {
      const out: Candle[] = [];
      out.push(mkCandle(t0, 100, 101, 99, 100));
      out.push(mkCandle(t0 + barMs, 100, 101, 99, 101));
      out.push(mkCandle(t0 + 2 * barMs, 101, 101, 100, 100));
      out.push(mkCandle(t0 + 3 * barMs, 100, 100, 99, 99));
      out.push(mkCandle(t0 + 4 * barMs, 99, 99, 98, 98));
      // entry at bar 5 open, massive rally to +10% = 107.8
      out.push(mkCandle(t0 + 5 * barMs, 98, 115, 98, 114));
      for (let i = 6; i < 15; i++)
        out.push(mkCandle(t0 + i * barMs, 114, 115, 113, 114));
      return out;
    };
    const r = runFtmoDaytrade24h({
      BTCUSDT: mkPat(),
      ETHUSDT: mkPat(),
      SOLUSDT: mkPat(),
    });
    // TP was hit — some trade should be positive
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
  });
});
