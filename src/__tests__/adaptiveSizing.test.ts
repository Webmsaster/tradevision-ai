import { describe, it, expect } from "vitest";
import {
  computeLiveEdgeStats,
  adaptiveStrategyStatsMap,
} from "@/utils/adaptiveSizing";

function trade(strategy: string, pnl: number, daysAgo: number) {
  return {
    strategy,
    netPnlPct: pnl,
    exitTime: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
  };
}

describe("adaptiveSizing — fallback to backtest when small sample", () => {
  it("n < 30 → uses backtest stats", () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      trade("hf-daytrading", 0.01, i),
    );
    const r = computeLiveEdgeStats(trades, "hf-daytrading");
    expect(r.usedLive).toBe(false);
    expect(r.liveN).toBe(10);
    expect(r.stats.winRate).toBe(r.backtest.winRate);
  });

  it("n >= 30 → switches to live stats", () => {
    // 25 wins, 5 losses → WR 83.3%
    const trades = [
      ...Array.from({ length: 25 }, (_, i) => trade("hf-daytrading", 0.005, i)),
      ...Array.from({ length: 5 }, (_, i) => trade("hf-daytrading", -0.02, i)),
    ];
    const r = computeLiveEdgeStats(trades, "hf-daytrading");
    expect(r.usedLive).toBe(true);
    expect(r.liveN).toBe(30);
    expect(r.stats.winRate).toBeCloseTo(25 / 30, 3);
    expect(r.stats.avgWinPct).toBeCloseTo(0.005, 3);
    expect(r.stats.avgLossPct).toBeCloseTo(0.02, 3);
  });

  it("ignores trades outside lookback window", () => {
    // All 30 trades are 90 days old; default lookback 60 days → none counted
    const trades = Array.from({ length: 30 }, () =>
      trade("hf-daytrading", 0.01, 90),
    );
    const r = computeLiveEdgeStats(trades, "hf-daytrading");
    expect(r.liveN).toBe(0);
    expect(r.usedLive).toBe(false);
  });

  it("custom minLiveN threshold works", () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      trade("hf-daytrading", 0.01, i),
    );
    const r = computeLiveEdgeStats(trades, "hf-daytrading", { minLiveN: 5 });
    expect(r.usedLive).toBe(true);
    expect(r.stats.winRate).toBe(1);
  });

  it("detects regime degradation: live WR << backtest", () => {
    // HF-daytrading backtest WR 85%; simulate 30 recent trades with only 50% WR
    const trades = [
      ...Array.from({ length: 15 }, (_, i) => trade("hf-daytrading", 0.005, i)),
      ...Array.from({ length: 15 }, (_, i) => trade("hf-daytrading", -0.02, i)),
    ];
    const r = computeLiveEdgeStats(trades, "hf-daytrading");
    expect(r.usedLive).toBe(true);
    expect(r.stats.winRate).toBeCloseTo(0.5, 2);
    expect(r.backtest.winRate).toBeCloseTo(0.85, 2);
    // live WR is 35pp below backtest — Kelly on live stats will size WAY down
  });
});

describe("adaptiveSizing — portfolio map", () => {
  it("returns a result for every known strategy", () => {
    const map = adaptiveStrategyStatsMap([]);
    expect(Object.keys(map).sort()).toEqual([
      "hf-daytrading",
      "hi-wr-1h",
      "vol-spike-1h",
    ]);
    for (const k of Object.keys(map)) {
      expect(map[k].usedLive).toBe(false);
      expect(map[k].liveN).toBe(0);
    }
  });
});
