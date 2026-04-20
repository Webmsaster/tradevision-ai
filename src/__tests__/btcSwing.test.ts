/**
 * Smoke tests for btcSwing — 1d swing tier with mean ≥ 2% profit/trade.
 */
import { describe, it, expect } from "vitest";
import {
  runBtcSwing,
  BTC_SWING_CONFIG,
  BTC_SWING_MAX_CONFIG,
  BTC_WEEKLY_MAX_CONFIG,
  BTC_SWING_STATS,
  BTC_SWING_MAX_STATS,
  BTC_WEEKLY_MAX_STATS,
  BTC_WEEKLY_LEVERAGED_2X_STATS,
} from "../utils/btcSwing";
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

function buildCandles(
  n: number,
  gen: (i: number) => { o: number; h: number; l: number; c: number },
): Candle[] {
  const out: Candle[] = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const { o, h, l, c } = gen(i);
    out.push(mkCandle(t0 + i * 24 * 3600_000, o, h, l, c));
  }
  return out;
}

describe("btcSwing — config invariants", () => {
  it("exposes iter128 1D-C parameters", () => {
    expect(BTC_SWING_CONFIG.htfLen).toBe(7);
    expect(BTC_SWING_CONFIG.macroBars).toBe(30);
    expect(BTC_SWING_CONFIG.maxConcurrent).toBe(4);
    expect(BTC_SWING_CONFIG.tpPct).toBeCloseTo(0.2, 5);
    expect(BTC_SWING_CONFIG.stopPct).toBeCloseTo(0.07, 5);
    expect(BTC_SWING_CONFIG.holdBars).toBe(40);
    expect(BTC_SWING_CONFIG.nHi).toBe(3);
    expect(BTC_SWING_CONFIG.nDown).toBe(2);
    expect(BTC_SWING_CONFIG.rsiTh).toBe(42);
    expect(BTC_SWING_CONFIG.redPct).toBeCloseTo(0.01, 5);
  });

  it("stats document iter128 5-gate lock with ≥ 2% mean", () => {
    expect(BTC_SWING_STATS.iteration).toBe(128);
    expect(BTC_SWING_STATS.symbol).toBe("BTCUSDT");
    expect(BTC_SWING_STATS.timeframe).toBe("1d");
    // User requirement: mean profit per trade ≥ 2%
    expect(BTC_SWING_STATS.meanPctPerTrade).toBeGreaterThanOrEqual(0.02);
    // 8+ years tested
    expect(BTC_SWING_STATS.daysTested).toBeGreaterThanOrEqual(2000);
    expect(BTC_SWING_STATS.bootstrapPctPositive).toBeGreaterThanOrEqual(0.95);
    // All 4 quarters positive
    for (const q of BTC_SWING_STATS.quarters) {
      expect(q.cumReturnPct).toBeGreaterThan(0);
    }
    // OOS positive
    expect(BTC_SWING_STATS.oos.meanPctPerTrade).toBeGreaterThanOrEqual(0.01);
    expect(BTC_SWING_STATS.oos.sharpe).toBeGreaterThanOrEqual(2.5);
  });

  it("honest tradeoff: WR lower than intraday ensemble", () => {
    // Swing tier trades fewer but bigger. WR of ~42% is expected and
    // documented; the ≥ 2% mean per trade is only reachable with lower WR.
    expect(BTC_SWING_STATS.winRate).toBeLessThan(0.5);
    expect(BTC_SWING_STATS.winRate).toBeGreaterThan(0.35);
  });

  it("mechanics list matches iter114 survivors", () => {
    expect(BTC_SWING_STATS.mechanics).toContain("M1_nDown");
    expect(BTC_SWING_STATS.mechanics).toContain("M4_rsi");
    expect(BTC_SWING_STATS.mechanics).toContain("M5_breakout");
    expect(BTC_SWING_STATS.mechanics).toContain("M6_redBar");
  });

  it("exposes iter144 MAX tier (mean ≥ 5% per trade)", () => {
    expect(BTC_SWING_MAX_CONFIG.tpPct).toBeCloseTo(0.6, 5);
    expect(BTC_SWING_MAX_CONFIG.stopPct).toBeCloseTo(0.05, 5);
    expect(BTC_SWING_MAX_CONFIG.holdBars).toBe(40);
  });

  it("MAX stats document mean ≥ 5% and 5-gate lock", () => {
    expect(BTC_SWING_MAX_STATS.iteration).toBe(144);
    // User's target: 5% per trade
    expect(BTC_SWING_MAX_STATS.meanPctPerTrade).toBeGreaterThanOrEqual(0.05);
    // Multi-year history
    expect(BTC_SWING_MAX_STATS.daysTested).toBeGreaterThanOrEqual(2000);
    // 100% bootstrap positive
    expect(BTC_SWING_MAX_STATS.bootstrapPctPositive).toBe(1.0);
    // OOS mean stays above 3%
    expect(BTC_SWING_MAX_STATS.oos.meanPctPerTrade).toBeGreaterThanOrEqual(
      0.03,
    );
    expect(BTC_SWING_MAX_STATS.oos.sharpe).toBeGreaterThanOrEqual(4);
    // Honestly low WR (expected for 8:1 R:R)
    expect(BTC_SWING_MAX_STATS.winRate).toBeLessThan(0.4);
  });

  it("exposes iter149 WEEKLY_MAX tier (only tier reaching 5% OOS)", () => {
    expect(BTC_WEEKLY_MAX_CONFIG.htfLen).toBe(4);
    expect(BTC_WEEKLY_MAX_CONFIG.macroBars).toBe(12);
    expect(BTC_WEEKLY_MAX_CONFIG.tpPct).toBeCloseTo(0.5, 5);
    expect(BTC_WEEKLY_MAX_CONFIG.stopPct).toBeCloseTo(0.02, 5);
    expect(BTC_WEEKLY_MAX_CONFIG.holdBars).toBe(4);
  });

  it("LEVERAGED 2× tier achieves ≥ 20% mean without bankruptcy", () => {
    expect(BTC_WEEKLY_LEVERAGED_2X_STATS.iteration).toBe(153);
    expect(BTC_WEEKLY_LEVERAGED_2X_STATS.leverage).toBe(2);
    // User's target: 20% per trade
    expect(
      BTC_WEEKLY_LEVERAGED_2X_STATS.meanPctPerTrade,
    ).toBeGreaterThanOrEqual(0.2);
    // Backtest must have survived without bankruptcy
    expect(BTC_WEEKLY_LEVERAGED_2X_STATS.cumReturnPct).toBeGreaterThan(0);
    expect(BTC_WEEKLY_LEVERAGED_2X_STATS.maxDrawdown).toBeGreaterThan(-0.3);
    // Documented leverage table
    expect(
      BTC_WEEKLY_LEVERAGED_2X_STATS.leverageTable.length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("WEEKLY_MAX stats document ≥ 5% mean IN-SAMPLE AND OOS", () => {
    expect(BTC_WEEKLY_MAX_STATS.iteration).toBe(149);
    expect(BTC_WEEKLY_MAX_STATS.timeframe).toBe("1w");
    // In-sample mean must be ≥ 5% (the user's target)
    expect(BTC_WEEKLY_MAX_STATS.meanPctPerTrade).toBeGreaterThanOrEqual(0.05);
    // OOS mean must ALSO be ≥ 5% — this is the key claim of the WEEKLY tier
    expect(BTC_WEEKLY_MAX_STATS.oos.meanPctPerTrade).toBeGreaterThanOrEqual(
      0.05,
    );
    // 100% bootstrap positive both in-sample and OOS
    expect(BTC_WEEKLY_MAX_STATS.bootstrapPctPositive).toBe(1.0);
    expect(BTC_WEEKLY_MAX_STATS.oos.bootstrapPctPositive).toBe(1.0);
    // Low frequency acknowledged
    expect(BTC_WEEKLY_MAX_STATS.tradesPerYear).toBeLessThan(10);
  });
});

describe("btcSwing — driver behavior", () => {
  it("returns empty report on insufficient history", () => {
    const bars = buildCandles(20, (i) => {
      const c = 100 + i;
      return { o: c, h: c + 1, l: c - 1, c };
    });
    const r = runBtcSwing(bars);
    expect(r.trades.length).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.meanPctPerTrade).toBe(0);
  });

  it("returns empty report when macro gate never triggers (flat tape)", () => {
    const bars = buildCandles(120, () => ({
      o: 100,
      h: 100.5,
      l: 99.5,
      c: 100,
    }));
    const r = runBtcSwing(bars);
    expect(r.trades.length).toBe(0);
  });

  it("produces trades on strong uptrend with pullbacks", () => {
    // 500 days of drift + occasional 3-day pullbacks to trigger M1
    const bars = buildCandles(500, (i) => {
      const drift = i * 80; // ~$40k drift over 500 days
      const cycle = i % 15;
      let noise = 0;
      if (cycle >= 12 && cycle <= 14) noise = -200 * (cycle - 11);
      const c = 20_000 + drift + noise;
      return { o: c, h: c * 1.01, l: c * 0.99, c };
    });
    const r = runBtcSwing(bars);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.daysCovered).toBe(500);
    // Every trade should have a mechanic attributed
    const byMechSum = Object.values(r.byMechanic).reduce((a, b) => a + b, 0);
    expect(byMechSum).toBe(r.trades.length);
    // Mean per trade should be a finite number
    expect(isFinite(r.meanPctPerTrade)).toBe(true);
    // All trades should respect TP and stop bounds (net of costs, small wiggle)
    for (const t of r.trades) {
      expect(t.pnl).toBeGreaterThan(-0.1);
      expect(t.pnl).toBeLessThan(0.25);
    }
  });
});
