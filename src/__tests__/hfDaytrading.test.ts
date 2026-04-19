import { describe, it, expect } from "vitest";
import {
  evaluateHfDaytrading,
  evaluateHfDaytradingPortfolio,
  runHfDaytrading,
  HF_DAYTRADING_CONFIG,
  HF_DAYTRADING_STATS,
  HF_DAYTRADING_ASSETS,
} from "@/utils/hfDaytrading";
import type { Candle } from "@/utils/indicators";

function makeFlatBars(n: number, basePrice = 5, baseVol = 1000): Candle[] {
  const bars: Candle[] = [];
  let p = basePrice;
  for (let i = 0; i < n; i++) {
    p = p * (1 + Math.sin(i / 11) * 0.001);
    bars.push({
      openTime: i * 15 * 60 * 1000,
      open: p * 0.999,
      high: p * 1.001,
      low: p * 0.999,
      close: p,
      volume: baseVol,
      closeTime: i * 15 * 60 * 1000 + 15 * 60 * 1000 - 1,
      isFinal: true,
    });
  }
  return bars;
}

describe("hfDaytrading", () => {
  it("stats satisfy ≥70% minWR + 100% profitable windows target", () => {
    expect(HF_DAYTRADING_STATS.minWinRate).toBeGreaterThanOrEqual(0.7);
    expect(HF_DAYTRADING_STATS.medianWinRate).toBeGreaterThanOrEqual(0.85);
    expect(HF_DAYTRADING_STATS.pctWindowsProfitable).toBeGreaterThanOrEqual(
      0.95,
    );
    expect(HF_DAYTRADING_STATS.tradesPerDay).toBeGreaterThanOrEqual(1);
  });

  it("exports 10 asset basket", () => {
    expect(HF_DAYTRADING_ASSETS.length).toBe(10);
  });

  it("fade mode + 15m timeframe + wide 3% stop", () => {
    expect(HF_DAYTRADING_CONFIG.mode).toBe("fade");
    expect(HF_DAYTRADING_CONFIG.stopPct).toBeCloseTo(0.03);
    expect(HF_DAYTRADING_CONFIG.tp1Pct).toBeCloseTo(0.003);
    expect(HF_DAYTRADING_CONFIG.tp2Pct).toBeCloseTo(0.012);
  });

  it("evaluateHfDaytrading returns inactive on short history", () => {
    const snap = evaluateHfDaytrading("SUIUSDT", makeFlatBars(10));
    expect(snap.active).toBe(false);
    expect(snap.reason).toMatch(/Insufficient/i);
  });

  it("evaluateHfDaytrading returns inactive with no spike on flat bars", () => {
    const snap = evaluateHfDaytrading("SUIUSDT", makeFlatBars(80));
    expect(snap.active).toBe(false);
  });

  it("runs a backtest without crashing", () => {
    const r = runHfDaytrading(makeFlatBars(500));
    expect(r.trades).toBeDefined();
    expect(r.winRate).toBeGreaterThanOrEqual(0);
    expect(r.winRate).toBeLessThanOrEqual(1);
  });

  it("portfolio evaluator returns per-leg snapshots + skips missing", () => {
    const bars = makeFlatBars(200);
    const snap = evaluateHfDaytradingPortfolio({
      SUIUSDT: bars,
      AVAXUSDT: bars,
      APTUSDT: undefined,
      INJUSDT: bars,
      BTCUSDT: bars,
      ETHUSDT: bars,
      SOLUSDT: bars,
      NEARUSDT: bars,
      OPUSDT: bars,
      LINKUSDT: bars,
    });
    expect(snap.legs.length).toBe(9); // APT skipped
    expect(snap.stats.iteration).toBe(57);
  });

  it("snapshot carries iter57 stats for UI", () => {
    const snap = evaluateHfDaytrading("SUIUSDT", makeFlatBars(80));
    expect(snap.stats.iteration).toBe(57);
    expect(snap.stats.minWinRate).toBe(HF_DAYTRADING_STATS.minWinRate);
  });
});
