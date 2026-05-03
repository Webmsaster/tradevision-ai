import { describe, it, expect } from "vitest";
import {
  kellyFraction,
  quarterKelly,
  fixedRiskNotional,
  kellyNotional,
  recommendSize,
  STRATEGY_EDGE_STATS,
} from "@/utils/positionSizing";

describe("positionSizing — Kelly", () => {
  it("kelly: positive expectancy returns positive f*", () => {
    // WR 70%, W 1%, L 1% → f* = (0.7 × 1 - 0.3) / 1 = 0.4
    const f = kellyFraction({
      winRate: 0.7,
      avgWinPct: 0.01,
      avgLossPct: 0.01,
    });
    expect(f).toBeCloseTo(0.4, 2);
  });

  it("kelly: negative expectancy returns 0", () => {
    // WR 30%, W 1%, L 2% → expectancy -11bp → f* < 0 → clamped to 0
    const f = kellyFraction({
      winRate: 0.3,
      avgWinPct: 0.01,
      avgLossPct: 0.02,
    });
    expect(f).toBe(0);
  });

  it("kelly: capped at 0.5 for unrealistic edges", () => {
    const f = kellyFraction({
      winRate: 0.99,
      avgWinPct: 0.1,
      avgLossPct: 0.01,
    });
    expect(f).toBe(0.5);
  });

  it("quarterKelly = 0.25 × full Kelly", () => {
    const stats = { winRate: 0.7, avgWinPct: 0.01, avgLossPct: 0.01 };
    expect(quarterKelly(stats)).toBeCloseTo(kellyFraction(stats) * 0.25, 3);
  });
});

describe("positionSizing — Fixed-Risk", () => {
  it("fixed-risk: 1% risk on 3% stop-distance → 33% of capital", () => {
    const n = fixedRiskNotional({
      capital: 10000,
      entry: 100,
      stop: 97,
      riskPct: 0.01,
    });
    // $10k × 1% / 3% = $3333.33
    expect(n).toBeCloseTo(3333.33, 0);
  });

  it("fixed-risk: zero stop-distance returns 0", () => {
    const n = fixedRiskNotional({
      capital: 10000,
      entry: 100,
      stop: 100,
      riskPct: 0.01,
    });
    expect(n).toBe(0);
  });
});

describe("positionSizing — Kelly notional", () => {
  it("kellyNotional: 70% WR, 1%/1%, 3% stop → 4/3 × f × capital", () => {
    const stats = { winRate: 0.7, avgWinPct: 0.01, avgLossPct: 0.01 };
    const n = kellyNotional(
      stats,
      { capital: 10000, entry: 100, stop: 97 },
      "quarter",
    );
    // quarterKelly = 0.4 × 0.25 = 0.1, stopDist = 0.03
    // notional = 10000 × 0.1 / 0.03 = 33333
    expect(n).toBeCloseTo(33333.33, 0);
  });
});

describe("positionSizing — recommendSize", () => {
  it("caps notional at 25% of capital by default", () => {
    const r = recommendSize({
      capital: 10000,
      entry: 100,
      stop: 97,
      stats: { winRate: 0.7, avgWinPct: 0.01, avgLossPct: 0.01 },
      method: "quarter-kelly",
    });
    expect(r.notional).toBe(10000 * 0.25);
    expect(r.notes.join(" ")).toMatch(/capped/i);
  });

  it("fixed-risk method works without stats (with cap raised to allow full 1% risk)", () => {
    // Default 25% cap on notional bites at 1% risk / 3% stop-dist (wants 33%).
    // Raise cap to verify the risk math itself.
    const r = recommendSize({
      capital: 10000,
      entry: 100,
      stop: 97,
      method: "fixed-risk",
      riskPct: 0.01,
      maxNotionalPctOfCapital: 0.5,
    });
    expect(r.method).toBe("fixed-risk");
    expect(r.maxLossPct).toBeCloseTo(0.01, 3);
    expect(r.kellyFraction).toBeUndefined();
  });

  it("fixed-risk: default 25% notional cap limits max loss to ~0.75% when stop is 3%", () => {
    // notional = cap × 25% = 2500, loss = 2500 × 0.03 = 75 → 0.75%
    const r = recommendSize({
      capital: 10000,
      entry: 100,
      stop: 97,
      method: "fixed-risk",
      riskPct: 0.01,
    });
    expect(r.notional).toBe(2500);
    expect(r.maxLossPct).toBeCloseTo(0.0075, 4);
    expect(r.notes.join(" ")).toMatch(/capped/i);
  });

  it("hf-daytrading: applies bootstrap edge stats", () => {
    const stats = STRATEGY_EDGE_STATS["hf-daytrading"];
    expect(stats!.winRate).toBe(0.85);
    expect(stats!.avgLossPct).toBeGreaterThan(stats!.avgWinPct);
    const r = recommendSize({
      capital: 10000,
      entry: 2.0,
      stop: 2.06,
      stats,
      method: "quarter-kelly",
    });
    expect(r.notional).toBeGreaterThan(0);
    expect(r.maxLoss).toBeGreaterThan(0);
    expect(r.maxLossPct).toBeLessThan(0.25); // sane bound
  });
});
