import { describe, it, expect } from "vitest";
import {
  walkForwardBacktest,
  monteCarloBacktest,
  multiTimeframeConsensus,
  suggestPositionSize,
  backtest,
  BacktestTrade,
} from "@/utils/signalEngine";
import type { Candle } from "@/utils/indicators";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 100,
    closeTime: (i + 1) * 60_000,
    isFinal: true,
  }));
}

function fakeTrade(pnlR: number, i = 0): BacktestTrade {
  return {
    openTime: i,
    closeTime: i + 1,
    direction: "long",
    entry: 100,
    exit: 100 + pnlR,
    pnlR,
  };
}

describe("walkForwardBacktest", () => {
  it("produces both in-sample and out-of-sample results", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.2);
    const result = walkForwardBacktest(makeCandles(closes));
    expect(result.inSample).toBeDefined();
    expect(result.outOfSample).toBeDefined();
  });

  it("does not flag overfitting when IS and OOS are similar", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.2);
    const result = walkForwardBacktest(makeCandles(closes));
    // Phase 50 (R45-TEST-3): assert PF condition first instead of using a
    // bare `if` — the previous form silently passed when PF<=1.5 (no
    // assertion ran), masking real overfit-detector regressions on
    // smooth-trend inputs that should yield a strong in-sample fit.
    expect(result.inSample.profitFactor).toBeGreaterThan(1.5);
    expect(result.overfitWarning).toBe(false);
  });
});

describe("monteCarloBacktest", () => {
  it("returns null with too few trades", () => {
    expect(monteCarloBacktest([])).toBeNull();
    expect(monteCarloBacktest([fakeTrade(1), fakeTrade(-1)])).toBeNull();
  });

  it("computes drawdown percentiles", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      fakeTrade(i % 3 === 0 ? 2 : -1, i),
    );
    const result = monteCarloBacktest(trades, 500);
    expect(result).not.toBeNull();
    expect(result!.medianMaxDrawdownR).toBeGreaterThan(0);
    expect(result!.p95MaxDrawdownR).toBeGreaterThanOrEqual(
      result!.medianMaxDrawdownR,
    );
    expect(result!.worstMaxDrawdownR).toBeGreaterThanOrEqual(
      result!.p95MaxDrawdownR,
    );
  });

  it("is reproducible (same seed)", () => {
    const trades = Array.from({ length: 15 }, (_, i) =>
      fakeTrade(i % 2 === 0 ? 3 : -1, i),
    );
    const a = monteCarloBacktest(trades, 300);
    const b = monteCarloBacktest(trades, 300);
    expect(a!.p95MaxDrawdownR).toBe(b!.p95MaxDrawdownR);
  });

  it("reports higher probOfProfit for winning trade sets", () => {
    const winning = Array.from({ length: 20 }, (_, i) =>
      fakeTrade(i % 3 === 0 ? -1 : 2, i),
    );
    const losing = Array.from({ length: 20 }, (_, i) =>
      fakeTrade(i % 3 === 0 ? 2 : -1, i),
    );
    const rW = monteCarloBacktest(winning, 500);
    const rL = monteCarloBacktest(losing, 500);
    expect(rW!.probOfProfit).toBeGreaterThan(rL!.probOfProfit);
  });
});

describe("multiTimeframeConsensus", () => {
  it("returns null with empty sets", () => {
    expect(multiTimeframeConsensus([])).toBeNull();
  });

  it("reports 100% confidence when all TFs agree", () => {
    const uptrend = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const consensus = multiTimeframeConsensus([
      { label: "5m", candles: makeCandles(uptrend) },
      { label: "15m", candles: makeCandles(uptrend) },
      { label: "1h", candles: makeCandles(uptrend) },
    ]);
    expect(consensus!.action).toBe("long");
    expect(consensus!.confidence).toBe(100);
  });

  it("reduces confidence when TFs disagree", () => {
    const uptrend = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const downtrend = Array.from({ length: 80 }, (_, i) => 200 - i * 0.5);
    const flat = Array.from({ length: 80 }, () => 100);
    const consensus = multiTimeframeConsensus([
      { label: "5m", candles: makeCandles(uptrend) },
      { label: "15m", candles: makeCandles(downtrend) },
      { label: "1h", candles: makeCandles(flat) },
    ]);
    expect(consensus!.confidence).toBeLessThan(80);
  });
});

describe("suggestPositionSize", () => {
  it("returns null on invalid input", () => {
    expect(
      suggestPositionSize({
        accountSize: 0,
        riskPercent: 1,
        entry: 100,
        stopLoss: 99,
      }),
    ).toBeNull();
    expect(
      suggestPositionSize({
        accountSize: 1000,
        riskPercent: 0,
        entry: 100,
        stopLoss: 99,
      }),
    ).toBeNull();
    expect(
      suggestPositionSize({
        accountSize: 1000,
        riskPercent: 1,
        entry: 100,
        stopLoss: 100,
      }),
    ).toBeNull();
  });

  it("computes quantity from 1% risk and 1-point stop", () => {
    const result = suggestPositionSize({
      accountSize: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 99,
    });
    expect(result!.dollarRisk).toBe(100);
    expect(result!.quantity).toBe(100);
  });

  it("scales quantity inversely with stop distance", () => {
    const tight = suggestPositionSize({
      accountSize: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 99.5,
    });
    const wide = suggestPositionSize({
      accountSize: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 95,
    });
    expect(tight!.quantity).toBeGreaterThan(wide!.quantity);
  });
});

describe("backtest still works after refactor", () => {
  it("produces backward-compatible output", () => {
    const closes = Array.from({ length: 150 }, (_, i) => 100 + i * 0.3);
    const r = backtest(makeCandles(closes));
    expect(typeof r.winRate).toBe("number");
    expect(typeof r.profitFactor).toBe("number");
  });
});
