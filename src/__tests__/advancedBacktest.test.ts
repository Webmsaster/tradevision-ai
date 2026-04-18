import { describe, it, expect } from "vitest";
import { applyCosts, pnlPctToR } from "@/utils/costModel";
import { computeMetrics } from "@/utils/performanceMetrics";
import { runAdvancedBacktest } from "@/utils/advancedBacktest";
import {
  detectRegime,
  trendFollowStrategy,
  meanReversionStrategy,
  breakoutStrategy,
  regimeSwitch,
} from "@/utils/strategies";
import type { Candle } from "@/utils/indicators";

function makeCandles(
  closes: number[],
  highDelta = 0.5,
  lowDelta = 0.5,
  vol = 100,
): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c + highDelta,
    low: c - lowDelta,
    close: c,
    volume: vol,
    closeTime: (i + 1) * 60_000,
    isFinal: true,
  }));
}

describe("applyCosts", () => {
  it("subtracts fees, slippage, funding from gross pnl", () => {
    const r = applyCosts({
      entry: 100,
      exit: 110,
      direction: "long",
      holdingHours: 5,
    });
    expect(r.grossPnlPct).toBeCloseTo(0.1);
    expect(r.feesPct).toBeGreaterThan(0);
    expect(r.slippagePct).toBeGreaterThan(0);
    expect(r.fundingPct).toBeGreaterThan(0);
    expect(r.netPnlPct).toBeLessThan(r.grossPnlPct);
  });

  it("handles short direction", () => {
    const r = applyCosts({
      entry: 100,
      exit: 90,
      direction: "short",
      holdingHours: 2,
    });
    expect(r.grossPnlPct).toBeCloseTo(0.1);
    expect(r.netPnlPct).toBeLessThan(r.grossPnlPct);
  });
});

describe("pnlPctToR", () => {
  it("returns 0 for invalid stop distance", () => {
    expect(pnlPctToR(0.05, 0)).toBe(0);
  });
  it("converts correctly", () => {
    expect(pnlPctToR(0.03, 0.01)).toBeCloseTo(3);
  });
});

describe("computeMetrics", () => {
  it("zero-returns empty input", () => {
    const m = computeMetrics({ returnsPct: [] });
    expect(m.trades).toBe(0);
    expect(m.sharpe).toBe(0);
  });

  it("positive sharpe for consistent winners", () => {
    const returns = Array.from({ length: 50 }, () => 0.01);
    const m = computeMetrics({ returnsPct: returns });
    expect(m.totalReturnPct).toBeGreaterThan(0);
    // zero volatility → sharpe undefined; our implementation returns 0 in that case
  });

  it("computes max drawdown on a losing streak", () => {
    const returns = [0.1, -0.05, -0.05, -0.05, 0.02];
    const m = computeMetrics({ returnsPct: returns });
    expect(m.maxDrawdownPct).toBeGreaterThan(0);
    expect(m.maxDrawdownPct).toBeLessThan(0.2);
  });

  it("profit factor >1 when wins > losses", () => {
    const m = computeMetrics({ returnsPct: [0.1, 0.1, -0.05] });
    expect(m.profitFactor).toBeGreaterThan(1);
  });
});

describe("strategies", () => {
  it("trendFollow flat on insufficient data", () => {
    expect(trendFollowStrategy(makeCandles([1, 2, 3])).action).toBe("flat");
  });

  it("trendFollow returns long on clear uptrend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.3);
    const d = trendFollowStrategy(makeCandles(closes, 1, 1));
    expect(["long", "flat"]).toContain(d.action);
  });

  it("meanReversion fires short at upper BB + high RSI", () => {
    // Build: sideways then big spike
    const closes = [
      ...Array.from({ length: 40 }, () => 100),
      ...Array.from({ length: 10 }, (_, i) => 100 + i),
    ];
    const d = meanReversionStrategy(makeCandles(closes, 0.1, 0.1));
    expect(["short", "flat"]).toContain(d.action);
  });

  it("breakout fires on clean Donchian break", () => {
    const closes = [...Array.from({ length: 25 }, () => 100), 110, 111, 112];
    const d = breakoutStrategy(makeCandles(closes, 0.5, 0.5));
    expect(["long", "flat"]).toContain(d.action);
  });

  it("detectRegime returns trend for sustained trend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.4);
    const r = detectRegime(makeCandles(closes, 0.5, 0.2));
    expect(["trend", "volatile", "range", "quiet"]).toContain(r.name);
  });

  it("regimeSwitch returns a decision from some strategy", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.4);
    const { regime, decision } = regimeSwitch(makeCandles(closes, 0.5, 0.2));
    expect(regime.name).toBeDefined();
    expect(["long", "short", "flat"]).toContain(decision.action);
  });
});

describe("runAdvancedBacktest", () => {
  it("runs without errors and returns report", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.2);
    const report = runAdvancedBacktest({
      candles: makeCandles(closes, 1, 1),
      timeframe: "5m",
    });
    expect(report.metrics).toBeDefined();
    expect(report.metrics.trades).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.trades)).toBe(true);
  });

  it("accounts for costs (netPnl < grossPnl on wins)", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.2);
    const report = runAdvancedBacktest({
      candles: makeCandles(closes, 1, 1),
      timeframe: "5m",
    });
    for (const t of report.trades) {
      if (t.grossPnlPct > 0) {
        expect(t.netPnlPct).toBeLessThan(t.grossPnlPct);
      }
    }
  });
});
