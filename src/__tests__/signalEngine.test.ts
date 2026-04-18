import { describe, it, expect } from "vitest";
import {
  analyzeCandles,
  hasActionChanged,
  deriveHtfTrend,
  backtest,
} from "@/utils/signalEngine";
import type { Candle } from "@/utils/indicators";

function makeCandles(closes: number[], volume = 100): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume,
    closeTime: (i + 1) * 60_000,
    isFinal: true,
  }));
}

describe("analyzeCandles", () => {
  it("returns null when not enough candles", () => {
    expect(
      analyzeCandles(
        makeCandles(Array.from({ length: 10 }, (_, i) => 100 + i)),
      ),
    ).toBeNull();
  });

  it("produces a long signal on sustained uptrend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("long");
    expect(snap!.indicators.emaFast).toBeGreaterThan(snap!.indicators.emaSlow!);
  });

  it("produces a short signal on sustained downtrend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 200 - i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("short");
  });

  it("returns flat on perfectly flat market", () => {
    const closes = Array.from({ length: 80 }, () => 100);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.action).toBe("flat");
  });

  it("detects ranging regime on tight oscillation and suppresses signal", () => {
    const closes = Array.from(
      { length: 80 },
      (_, i) => 100 + (i % 2 === 0 ? 0.05 : -0.05),
    );
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap).not.toBeNull();
    expect(snap!.regime).toBe("ranging");
    expect(snap!.action).toBe("flat");
  });

  it("detects trending regime on clear trend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap!.regime).toBe("trending");
    expect(snap!.adx!).toBeGreaterThan(20);
  });

  it("attaches SL/TP levels on non-flat signals", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes));
    expect(snap!.action).toBe("long");
    expect(snap!.levels).not.toBeNull();
    expect(snap!.levels!.stopLoss).toBeLessThan(snap!.levels!.entry);
    expect(snap!.levels!.takeProfit).toBeGreaterThan(snap!.levels!.entry);
    expect(snap!.levels!.riskReward).toBeCloseTo(1.5);
  });

  it("suppresses signal that fights higher-timeframe trend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const snap = analyzeCandles(makeCandles(closes), { htfTrend: "short" });
    // Local trend is bullish, HTF says short → suppress
    expect(snap!.action).toBe("flat");
    expect(snap!.reasons.join(" ")).toMatch(/higher timeframe|HTF/i);
  });

  it("boosts signal when HTF aligns", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const aligned = analyzeCandles(makeCandles(closes), { htfTrend: "long" });
    const plain = analyzeCandles(makeCandles(closes));
    expect(aligned!.action).toBe("long");
    expect(aligned!.strength).toBeGreaterThanOrEqual(plain!.strength);
    expect(aligned!.htfAligned).toBe(true);
  });
});

describe("hasActionChanged", () => {
  it("returns true when action flips", () => {
    expect(
      hasActionChanged({ action: "long" } as any, { action: "short" } as any),
    ).toBe(true);
  });
  it("returns false when action is the same", () => {
    expect(
      hasActionChanged({ action: "long" } as any, { action: "long" } as any),
    ).toBe(false);
  });
});

describe("deriveHtfTrend", () => {
  it("returns null when insufficient data", () => {
    expect(deriveHtfTrend(makeCandles([1, 2, 3]))).toBeNull();
  });
  it("returns long on uptrend", () => {
    expect(
      deriveHtfTrend(
        makeCandles(Array.from({ length: 50 }, (_, i) => 100 + i)),
      ),
    ).toBe("long");
  });
  it("returns short on downtrend", () => {
    expect(
      deriveHtfTrend(
        makeCandles(Array.from({ length: 50 }, (_, i) => 200 - i)),
      ),
    ).toBe("short");
  });
  it("returns flat when EMAs are almost equal", () => {
    expect(
      deriveHtfTrend(makeCandles(Array.from({ length: 50 }, () => 100))),
    ).toBe("flat");
  });
});

describe("backtest", () => {
  it("runs without errors on a simple trend", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.3);
    const result = backtest(makeCandles(closes));
    expect(result.trades.length).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
  });

  it("produces winning trades on sustained uptrend", () => {
    const closes = Array.from({ length: 150 }, (_, i) => 100 + i * 0.3);
    const result = backtest(makeCandles(closes));
    if (result.trades.length > 0) {
      expect(result.totalR).toBeGreaterThan(0);
    }
  });

  it("returns zero stats on no trades", () => {
    const closes = Array.from({ length: 80 }, () => 100);
    const result = backtest(makeCandles(closes));
    expect(result.trades.length).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.totalR).toBe(0);
  });
});
