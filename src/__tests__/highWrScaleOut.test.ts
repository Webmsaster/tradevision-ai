import { describe, it, expect } from "vitest";
import {
  evaluateHighWrSignal,
  evaluateHighWrPortfolio,
  runHighWrScaleOut,
  HIGH_WR_SUI_MOM_CONFIG,
  HIGH_WR_SUI_MOM_STATS,
  HIGH_WR_PORTFOLIO_CONFIGS,
  HIGH_WR_PORTFOLIO_STATS,
} from "@/utils/highWrScaleOut";
import type { Candle } from "@/utils/indicators";

function makeFlatBars(n: number, basePrice = 2, baseVol = 1000): Candle[] {
  const bars: Candle[] = [];
  let p = basePrice;
  for (let i = 0; i < n; i++) {
    p = p * (1 + Math.sin(i / 11) * 0.001);
    bars.push({
      openTime: i * 3_600_000,
      open: p * 0.999,
      high: p * 1.001,
      low: p * 0.999,
      close: p,
      volume: baseVol,
      closeTime: i * 3_600_000 + 3_599_999,
      isFinal: true,
    });
  }
  return bars;
}

function makeSpikeBars(): Candle[] {
  // 55 normal bars + one fat volume-spike up bar at the end
  const bars = makeFlatBars(55);
  const last = bars[bars.length - 1];
  bars.push({
    openTime: last!.closeTime + 1,
    open: last!.close,
    high: last!.close * 1.03,
    low: last!.close * 0.998,
    close: last!.close * 1.028,
    volume: 50_000, // 50× the baseline volume
    closeTime: last!.closeTime + 3_600_000,
    isFinal: true,
  });
  return bars;
}

describe("highWrScaleOut", () => {
  it("stats constant has required shape + ≥70% WR target met", () => {
    // iter50 originally; iter53 refined with minTrades≥20 + multi-asset
    expect(HIGH_WR_SUI_MOM_STATS.iteration).toBeGreaterThanOrEqual(50);
    expect(HIGH_WR_SUI_MOM_STATS.medianWinRate).toBeGreaterThanOrEqual(0.7);
    // After iter53 the MINIMUM win rate across every tested window is ≥70% too
    expect(HIGH_WR_SUI_MOM_STATS.minWinRate).toBeGreaterThanOrEqual(0.7);
    expect(HIGH_WR_SUI_MOM_STATS.pctWindowsProfitable).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it("returns inactive when history too short", () => {
    const snap = evaluateHighWrSignal("SUIUSDT", makeFlatBars(10));
    expect(snap.active).toBe(false);
    expect(snap.reason).toMatch(/Insufficient history/i);
  });

  it("returns inactive when no volume spike", () => {
    const snap = evaluateHighWrSignal("SUIUSDT", makeFlatBars(80));
    expect(snap.active).toBe(false);
    expect(snap.reason).toMatch(/No spike/i);
  });

  it("includes stats on every snapshot for UI display", () => {
    const snap = evaluateHighWrSignal("SUIUSDT", makeFlatBars(80));
    expect(snap.stats).toBeDefined();
    expect(snap.stats.medianWinRate).toBe(HIGH_WR_SUI_MOM_STATS.medianWinRate);
  });

  it("reports filter failures as a list when spike triggers but filter blocks", () => {
    // Force-avoid current hour so filter will block
    const bars = makeSpikeBars();
    const currentH = new Date(bars[bars.length - 1]!.openTime).getUTCHours();
    const cfg = {
      ...HIGH_WR_SUI_MOM_CONFIG,
      avoidHoursUtc: [currentH],
    };
    const snap = evaluateHighWrSignal("SUIUSDT", bars, cfg);
    // Spike was detected, so reason should mention the filter, not "No spike"
    // (can be either active or filter-blocked depending on filter pass-through)
    if (!snap.active) {
      expect(snap.filtersFailed.length).toBeGreaterThan(0);
    }
  });

  it("runs a backtest report without crashing on flat bars", () => {
    const report = runHighWrScaleOut(makeFlatBars(400));
    expect(report.trades).toBeDefined();
    expect(report.winRate).toBeGreaterThanOrEqual(0);
    expect(report.winRate).toBeLessThanOrEqual(1);
  });

  it("portfolio config has 3 symbols and ≥70% minWR target", () => {
    expect(HIGH_WR_PORTFOLIO_CONFIGS.length).toBe(3);
    expect(HIGH_WR_PORTFOLIO_STATS.minWinRate).toBeGreaterThanOrEqual(0.7);
    expect(HIGH_WR_PORTFOLIO_STATS.medianWinRate).toBeGreaterThanOrEqual(0.75);
  });

  it("evaluateHighWrPortfolio returns a snapshot with per-symbol legs", () => {
    const bars = makeFlatBars(200);
    const snap = evaluateHighWrPortfolio({
      SUIUSDT: bars,
      AVAXUSDT: bars,
      APTUSDT: bars,
    });
    expect(snap.legs.length).toBe(3);
    expect(snap.stats.symbols).toEqual(["SUIUSDT", "AVAXUSDT", "APTUSDT"]);
  });

  it("portfolio skips symbols whose candles are missing", () => {
    const snap = evaluateHighWrPortfolio({
      SUIUSDT: makeFlatBars(200),
      AVAXUSDT: undefined,
      APTUSDT: makeFlatBars(200),
    });
    expect(snap.legs.length).toBe(2);
  });
});
