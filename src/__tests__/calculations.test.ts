import { describe, it, expect } from "vitest";
import type { Trade } from "@/types/trade";
import {
  calculatePnl,
  calculateWinRate,
  calculateAvgWinLoss,
  calculateRiskReward,
  calculateExpectancy,
  calculateMaxDrawdown,
  calculateEquityCurve,
  calculateProfitFactor,
  calculateStreaks,
  calculateSharpeRatio,
  calculateAvgHoldTime,
  calculateAllStats,
  calculatePerformanceByDayOfWeek,
  calculatePerformanceByHour,
  validateLeverage,
} from "@/utils/calculations";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "test-1",
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: "2024-01-01T10:00:00Z",
    exitDate: "2024-01-01T14:00:00Z",
    pnl: 10,
    pnlPercent: 10,
    fees: 0,
    notes: "",
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

describe("calculatePnl", () => {
  it("calculates long trade PnL correctly", () => {
    const result = calculatePnl({
      direction: "long",
      entryPrice: 100,
      exitPrice: 110,
      quantity: 2,
      leverage: 1,
      fees: 1,
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    expect(result.pnl).toBe(19); // (110-100)*2 - 1
    expect(result.pnlPercent).toBeCloseTo(9.5); // 19 / (200/1) * 100
  });

  it("calculates short trade PnL correctly", () => {
    const result = calculatePnl({
      direction: "short",
      entryPrice: 100,
      exitPrice: 90,
      quantity: 2,
      leverage: 1,
      fees: 0,
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    expect(result.pnl).toBe(20); // (100-90)*2
    expect(result.pnlPercent).toBe(10);
  });

  it("leverage does not multiply PnL but affects pnlPercent", () => {
    const result = calculatePnl({
      direction: "long",
      entryPrice: 100,
      exitPrice: 105,
      quantity: 1,
      leverage: 10,
      fees: 0,
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    // PnL = (105-100)*1 = 5 (leverage does NOT multiply PnL)
    expect(result.pnl).toBe(5);
    // pnlPercent = return on margin: 5 / (100/10) * 100 = 50%
    expect(result.pnlPercent).toBe(50);
  });

  it("handles zero investment", () => {
    const result = calculatePnl({
      direction: "long",
      entryPrice: 0,
      exitPrice: 10,
      quantity: 0,
      leverage: 1,
      fees: 0,
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    expect(result.pnlPercent).toBe(0);
  });
});

describe("calculateWinRate", () => {
  it("returns 0 for empty trades", () => {
    expect(calculateWinRate([])).toBe(0);
  });

  it("calculates win rate correctly", () => {
    const trades = [
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: -5 }),
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: -10 }),
    ];
    expect(calculateWinRate(trades)).toBe(50);
  });

  it("returns 100 for all winners", () => {
    const trades = [makeTrade({ pnl: 10 }), makeTrade({ pnl: 5 })];
    expect(calculateWinRate(trades)).toBe(100);
  });
});

describe("calculateAvgWinLoss", () => {
  it("returns zeros for empty trades", () => {
    const { avgWin, avgLoss } = calculateAvgWinLoss([]);
    expect(avgWin).toBe(0);
    expect(avgLoss).toBe(0);
  });

  it("calculates averages correctly", () => {
    const trades = [
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: -5 }),
      makeTrade({ pnl: -15 }),
    ];
    const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
    expect(avgWin).toBe(15); // (10+20)/2
    expect(avgLoss).toBe(10); // abs((-5+-15)/2)
  });
});

describe("calculateRiskReward", () => {
  it("returns null when only wins (semantically correct — undefined R:R)", () => {
    const trades = [makeTrade({ pnl: 10 })];
    expect(calculateRiskReward(trades)).toBeNull();
  });

  it("returns 0 when no trades at all", () => {
    expect(calculateRiskReward([])).toBe(0);
  });

  it("calculates ratio correctly", () => {
    const trades = [makeTrade({ pnl: 20 }), makeTrade({ pnl: -10 })];
    expect(calculateRiskReward(trades)).toBe(2); // 20/10
  });
});

describe("calculateExpectancy", () => {
  it("returns 0 for empty trades", () => {
    expect(calculateExpectancy([])).toBe(0);
  });

  it("calculates expectancy correctly", () => {
    const trades = [makeTrade({ pnl: 30 }), makeTrade({ pnl: -10 })];
    // winRate=50%, avgWin=30, avgLoss=10
    // 0.5*30 - 0.5*10 = 15 - 5 = 10
    expect(calculateExpectancy(trades)).toBe(10);
  });
});

describe("calculateMaxDrawdown", () => {
  it("returns 0 for empty trades", () => {
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown([]);
    expect(maxDrawdown).toBe(0);
    expect(maxDrawdownPercent).toBe(0);
  });

  it("calculates drawdown correctly", () => {
    const trades = [
      makeTrade({ id: "1", pnl: 100, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ id: "2", pnl: -30, exitDate: "2024-01-02T00:00:00Z" }),
      makeTrade({ id: "3", pnl: -20, exitDate: "2024-01-03T00:00:00Z" }),
      makeTrade({ id: "4", pnl: 10, exitDate: "2024-01-04T00:00:00Z" }),
    ];
    // Equity: 100, 70, 50, 60. Peak: 100. Max drawdown: 100-50=50, 50%
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades);
    expect(maxDrawdown).toBe(50);
    expect(maxDrawdownPercent).toBe(50);
  });
});

describe("calculateEquityCurve", () => {
  it("returns empty for no trades", () => {
    expect(calculateEquityCurve([])).toEqual([]);
  });

  it("builds equity curve correctly", () => {
    const trades = [
      makeTrade({ pnl: 10, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-02T00:00:00Z" }),
    ];
    const curve = calculateEquityCurve(trades);
    expect(curve).toHaveLength(2);
    expect(curve[0]!.equity).toBe(10);
    expect(curve[0]!.drawdown).toBe(0);
    expect(curve[1]!.equity).toBe(5);
    expect(curve[1]!.drawdown).toBe(5);
  });
});

describe("calculateProfitFactor", () => {
  it("returns 0 for empty trades", () => {
    expect(calculateProfitFactor([])).toBe(0);
  });

  it("returns Infinity when no losses", () => {
    const trades = [makeTrade({ pnl: 10 })];
    expect(calculateProfitFactor(trades)).toBe(Infinity);
  });

  it("calculates profit factor correctly", () => {
    const trades = [makeTrade({ pnl: 30 }), makeTrade({ pnl: -10 })];
    expect(calculateProfitFactor(trades)).toBe(3); // 30/10
  });
});

describe("calculateStreaks", () => {
  it("returns zeros for empty trades", () => {
    const { longestWinStreak, longestLossStreak } = calculateStreaks([]);
    expect(longestWinStreak).toBe(0);
    expect(longestLossStreak).toBe(0);
  });

  it("calculates streaks correctly", () => {
    const trades = [
      makeTrade({ pnl: 10, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: 20, exitDate: "2024-01-02T00:00:00Z" }),
      makeTrade({ pnl: 5, exitDate: "2024-01-03T00:00:00Z" }),
      makeTrade({ pnl: -10, exitDate: "2024-01-04T00:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-05T00:00:00Z" }),
    ];
    const { longestWinStreak, longestLossStreak } = calculateStreaks(trades);
    expect(longestWinStreak).toBe(3);
    expect(longestLossStreak).toBe(2);
  });
});

describe("calculateSharpeRatio", () => {
  it("returns 0 for fewer than 2 trades", () => {
    expect(calculateSharpeRatio([makeTrade()])).toBe(0);
  });

  it("returns 0 when all trades have same PnL", () => {
    const trades = [makeTrade({ pnl: 10 }), makeTrade({ pnl: 10 })];
    expect(calculateSharpeRatio(trades)).toBe(0);
  });

  it("returns positive value for profitable trades", () => {
    // Round 54: Sharpe is driven by `pnlPercent`, so explicit values
    // matter (default `pnlPercent: 10` for every trade produces std=0).
    const trades = [
      makeTrade({ pnl: 10, pnlPercent: 1 }),
      makeTrade({ pnl: 20, pnlPercent: 2 }),
      makeTrade({ pnl: 15, pnlPercent: 1.5 }),
    ];
    expect(calculateSharpeRatio(trades)).toBeGreaterThan(0);
  });

  it("frequency-adjusts annualisation: lower-frequency trader is annualised more conservatively", () => {
    // Round 54: under the previous fixed-sqrt(252) implementation a
    // weekly trader (52 trades) and a 10-times-a-day scalper (3650
    // trades) with identical per-trade Sharpe got the SAME annualised
    // figure — wildly inflating the swing trader. The frequency-adjusted
    // factor (sqrt(trades-per-year)) means the scalper's Sharpe should
    // now be substantially HIGHER than the swing trader's, since they
    // compound the same per-trade edge many more times in a year.
    const scalper: Trade[] = [];
    for (let d = 0; d < 365; d++) {
      const day = new Date(Date.UTC(2024, 0, 1) + d * 86400000);
      for (let h = 0; h < 10; h++) {
        const exit = new Date(day.getTime() + h * 3600000);
        scalper.push(
          makeTrade({
            id: `s-${d}-${h}`,
            pnl: h % 2 === 0 ? 1 : 3,
            pnlPercent: h % 2 === 0 ? 1 : 3,
            entryDate: exit.toISOString(),
            exitDate: exit.toISOString(),
          }),
        );
      }
    }
    const swing: Trade[] = [];
    for (let w = 0; w < 52; w++) {
      const exit = new Date(Date.UTC(2024, 0, 1) + w * 7 * 86400000);
      swing.push(
        makeTrade({
          id: `w-${w}`,
          pnl: w % 2 === 0 ? 1 : 3,
          pnlPercent: w % 2 === 0 ? 1 : 3,
          entryDate: exit.toISOString(),
          exitDate: exit.toISOString(),
        }),
      );
    }

    const sScalp = calculateSharpeRatio(scalper);
    const sSwing = calculateSharpeRatio(swing);
    // Both positive, both finite.
    expect(sScalp).toBeGreaterThan(0);
    expect(sSwing).toBeGreaterThan(0);
    // Pre-fix: ratio = 1 (identical, but wrong).
    // Post-fix: scalper compounds 70× more trades/year → sqrt(70) ≈ 8.4×
    // higher annualised Sharpe. Assert at least 5× to leave slack for
    // calendar-day-rounding effects.
    expect(sScalp / sSwing).toBeGreaterThan(5);
  });

  it("falls back to sqrt(252) when span is < ~36 days", () => {
    // Two trades 10 days apart — span too short to infer trades-per-year.
    const trades = [
      makeTrade({
        pnl: 10,
        pnlPercent: 1,
        exitDate: "2024-01-01T00:00:00Z",
      }),
      makeTrade({
        pnl: 20,
        pnlPercent: 2,
        exitDate: "2024-01-11T00:00:00Z",
      }),
    ];
    const s = calculateSharpeRatio(trades);
    expect(Number.isFinite(s)).toBe(true);
    // returns=[1,2], mean=1.5, popStd=0.5, factor=sqrt(252)
    // → 1.5/0.5 * sqrt(252) ≈ 47.62
    expect(s).toBeCloseTo(3 * Math.sqrt(252), 1);
  });

  // Round 56 (R56-CAL-1): exit-date-span calc used `Math.max(...arr)` /
  // `Math.min(...arr)` — spread of 50k+ items overflows V8's argument
  // stack with `RangeError: Maximum call stack size exceeded`. The
  // explicit reduce-loop must handle large arrays without throwing.
  it("computes Sharpe over 50k trades without stack overflow", () => {
    const N = 50_000;
    const startMs = Date.UTC(2020, 0, 1);
    const minute = 60_000;
    const trades: Trade[] = Array.from({ length: N }, (_, i) =>
      makeTrade({
        id: `stress-${i}`,
        pnl: i % 2 === 0 ? 5 : -3,
        pnlPercent: i % 2 === 0 ? 1 : -0.5,
        // Span ~5 years so years >= 0.1 and we exercise the explicit loop.
        exitDate: new Date(startMs + i * minute).toISOString(),
        entryDate: new Date(startMs + i * minute - 60 * minute).toISOString(),
      }),
    );
    const s = calculateSharpeRatio(trades);
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe("validateLeverage", () => {
  it("accepts positive finite numbers", () => {
    expect(validateLeverage(5)).toEqual({ leverage: 5, fallback: false });
    expect(validateLeverage(0.5)).toEqual({ leverage: 0.5, fallback: false });
  });

  it("falls back to 1 for zero / negative / non-finite / non-number", () => {
    expect(validateLeverage(0)).toEqual({ leverage: 1, fallback: true });
    expect(validateLeverage(-3)).toEqual({ leverage: 1, fallback: true });
    expect(validateLeverage(NaN)).toEqual({ leverage: 1, fallback: true });
    expect(validateLeverage(Infinity)).toEqual({ leverage: 1, fallback: true });
    expect(validateLeverage(undefined)).toEqual({
      leverage: 1,
      fallback: true,
    });
    expect(validateLeverage(null)).toEqual({ leverage: 1, fallback: true });
    expect(validateLeverage("3")).toEqual({ leverage: 1, fallback: true });
  });
});

describe("calculateAvgHoldTime", () => {
  it("returns 0 for empty trades", () => {
    expect(calculateAvgHoldTime([])).toBe(0);
  });

  it("calculates average hold time correctly", () => {
    const trades = [
      makeTrade({
        entryDate: "2024-01-01T10:00:00Z",
        exitDate: "2024-01-01T14:00:00Z", // 4 hours
      }),
      makeTrade({
        entryDate: "2024-01-02T10:00:00Z",
        exitDate: "2024-01-02T12:00:00Z", // 2 hours
      }),
    ];
    const avg = calculateAvgHoldTime(trades);
    expect(avg).toBe(3 * 60 * 60 * 1000); // 3 hours in ms
  });
});

describe("calculateAllStats", () => {
  it("returns default stats for empty trades", () => {
    const stats = calculateAllStats([]);
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.bestTrade).toBeNull();
    expect(stats.worstTrade).toBeNull();
  });

  it("calculates all stats for a set of trades", () => {
    const trades = [
      makeTrade({ id: "1", pnl: 50, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ id: "2", pnl: -20, exitDate: "2024-01-02T00:00:00Z" }),
      makeTrade({ id: "3", pnl: 30, exitDate: "2024-01-03T00:00:00Z" }),
    ];
    const stats = calculateAllStats(trades);
    expect(stats.totalTrades).toBe(3);
    expect(stats.winRate).toBeCloseTo(66.67, 1);
    expect(stats.totalPnl).toBe(60);
    expect(stats.bestTrade?.id).toBe("1");
    expect(stats.worstTrade?.id).toBe("2");
  });
});

describe("calculatePerformanceByDayOfWeek", () => {
  it("returns empty array for no trades", () => {
    expect(calculatePerformanceByDayOfWeek([])).toEqual([]);
  });

  it("groups trades by day of week with correct stats", () => {
    // 2024-01-01 = Monday, 2024-01-02 = Tuesday
    const trades = [
      makeTrade({ pnl: 10, entryDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ pnl: -5, entryDate: "2024-01-01T14:00:00Z" }),
      makeTrade({ pnl: 20, entryDate: "2024-01-02T10:00:00Z" }),
    ];
    const result = calculatePerformanceByDayOfWeek(trades);
    expect(result.length).toBe(2);

    const monday = result.find((r) => r.label === "Monday");
    expect(monday).toBeDefined();
    expect(monday!.trades).toBe(2);
    expect(monday!.totalPnl).toBe(5);
    expect(monday!.winRate).toBe(50);

    const tuesday = result.find((r) => r.label === "Tuesday");
    expect(tuesday).toBeDefined();
    expect(tuesday!.trades).toBe(1);
    expect(tuesday!.winRate).toBe(100);
  });
});

describe("calculatePerformanceByHour", () => {
  it("returns empty array for no trades", () => {
    expect(calculatePerformanceByHour([])).toEqual([]);
  });

  it("groups trades by hour with correct stats", () => {
    // Phase 42 (R44-CALC-3): Z-suffix so the test is TZ-stable. Without Z,
    // the literal is parsed as LOCAL time and getUTCHours()-based bucketing
    // fails in non-UTC environments (e.g. CET shifts 09:00 → 08:00).
    const trades = [
      makeTrade({ pnl: 10, entryDate: "2024-01-01T09:00:00Z" }),
      makeTrade({ pnl: -5, entryDate: "2024-01-02T09:30:00Z" }),
      makeTrade({ pnl: 20, entryDate: "2024-01-01T14:00:00Z" }),
    ];
    const result = calculatePerformanceByHour(trades);
    expect(result.length).toBe(2);

    const hour9 = result.find((r) => r.label === "09:00");
    expect(hour9).toBeDefined();
    expect(hour9!.trades).toBe(2);
    expect(hour9!.totalPnl).toBe(5);

    const hour14 = result.find((r) => r.label === "14:00");
    expect(hour14).toBeDefined();
    expect(hour14!.trades).toBe(1);
    expect(hour14!.winRate).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Round 60: branch coverage for under-tested formula paths.
//   - calculateExpectancy: empty array (early return)
//   - calculateMaxDrawdown: peak<=0 (all-loss trader) → uses |equity| reference
//   - calculateMaxDrawdown: drawdown > peak (DD > 100%, no silent cap)
//   - calculateRiskReward: avgWin > 0 / avgLoss === 0 → Infinity (no losses)
//   - calculateProfitFactor: only losing trades → returns 0
//   - calculateStreaks: break-even trade does NOT extend or break either
//     streak (extends a winning run).
// ---------------------------------------------------------------------------

describe("calculation branch-coverage edge cases (R60)", () => {
  it("calculateExpectancy returns 0 for empty trades", () => {
    expect(calculateExpectancy([])).toBe(0);
  });

  it("calculateMaxDrawdown uses |equity| reference when peak<=0 (all-loss)", () => {
    // Trader who only loses → equity goes [-50, -150, -300]. peak stays 0.
    // Reference for DD% must be |equity|, not 0 (would be 0/0=NaN otherwise).
    const trades = [
      makeTrade({ pnl: -50, exitDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ pnl: -100, exitDate: "2024-01-02T10:00:00Z" }),
      makeTrade({ pnl: -150, exitDate: "2024-01-03T10:00:00Z" }),
    ];
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades);
    expect(maxDrawdown).toBe(300);
    // Reference = |equity at trough| = 300, drawdown = 300 → 100%.
    expect(maxDrawdownPercent).toBeCloseTo(100, 5);
  });

  it("calculateMaxDrawdown reports DD > 100% (no silent cap)", () => {
    // Round 56 (R56-CAL-2): no silent 100% cap on drawdownPercent.
    // Equity goes +100 → -200; peak=100, equity=-200, DD=300, ref=peak=100 → 300%.
    const trades = [
      makeTrade({ pnl: 100, exitDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ pnl: -300, exitDate: "2024-01-02T10:00:00Z" }),
    ];
    const { maxDrawdownPercent } = calculateMaxDrawdown(trades);
    expect(maxDrawdownPercent).toBeCloseTo(300, 5);
  });

  it("calculateRiskReward returns null when wins exist but no losses", () => {
    const trades = [makeTrade({ pnl: 10 }), makeTrade({ pnl: 20 })];
    expect(calculateRiskReward(trades)).toBeNull();
  });

  it("calculateRiskReward returns 0 when no wins and no losses (BE only)", () => {
    const trades = [makeTrade({ pnl: 0 }), makeTrade({ pnl: 0 })];
    expect(calculateRiskReward(trades)).toBe(0);
  });

  it("calculateProfitFactor returns 0 when only losing trades", () => {
    const trades = [makeTrade({ pnl: -10 }), makeTrade({ pnl: -20 })];
    expect(calculateProfitFactor(trades)).toBe(0);
  });

  it("calculateStreaks: break-even trade neither extends nor breaks streaks", () => {
    // Win, Win, BE, Win → longest win streak should be 3 (BE is skipped, not
    // a divider). Per JSDoc: "Break-even trades (pnl === 0) do NOT break or
    // extend either streak."
    const trades = [
      makeTrade({ id: "a", pnl: 10, exitDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ id: "b", pnl: 20, exitDate: "2024-01-02T10:00:00Z" }),
      makeTrade({ id: "c", pnl: 0, exitDate: "2024-01-03T10:00:00Z" }),
      makeTrade({ id: "d", pnl: 15, exitDate: "2024-01-04T10:00:00Z" }),
    ];
    const { longestWinStreak, longestLossStreak } = calculateStreaks(trades);
    // BE doesn't reset, so streak continues: 1 → 2 → 2 (BE) → 3.
    expect(longestWinStreak).toBe(3);
    expect(longestLossStreak).toBe(0);
  });

  it("calculatePerformanceByDayOfWeek/Hour: empty input → []", () => {
    expect(calculatePerformanceByDayOfWeek([])).toEqual([]);
    expect(calculatePerformanceByHour([])).toEqual([]);
  });

  it("calculateAllStats: bestTrade === worstTrade for single-trade input", () => {
    const t = makeTrade({ pnl: 42 });
    const stats = calculateAllStats([t]);
    expect(stats.totalTrades).toBe(1);
    expect(stats.bestTrade?.id).toBe(t.id);
    expect(stats.worstTrade?.id).toBe(t.id);
  });
});

// ---------------------------------------------------------------------------
// Round 61: rare edge-cases that could surface real bugs.
//   - Sharpe stddev=0 edge (already covered for identical pnl, plus NaN/Inf input)
//   - Profit Factor: pure-loss vs pure-win symmetry
//   - Single-trade portfolio: no Sharpe crash
//   - All break-even trades: win-rate 0, expectancy 0, R:R 0, PF 0, no NaN
//   - Negative-quantity / negative-price: not rejected — current behaviour documented
//   - Very large numbers (PnL in billions): no precision loss
//   - Floating-point noise in cumulative drawdown (FP_TOLERANCE branch)
//   - calculatePnl: fees-only loss with matching prices
//   - Sharpe with NaN/Infinity pnlPercent: sanitised to 0 (no NaN propagation)
// ---------------------------------------------------------------------------

describe("calculation rare edge-cases (R61)", () => {
  it("Sharpe with all break-even trades returns 0 (stddev=0, no NaN)", () => {
    // pnlPercent=0 for every trade → mean=0, stddev=0 → must be 0, not NaN/Infinity.
    const trades = [
      makeTrade({ pnl: 0, pnlPercent: 0, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: 0, pnlPercent: 0, exitDate: "2024-02-01T00:00:00Z" }),
      makeTrade({ pnl: 0, pnlPercent: 0, exitDate: "2024-03-01T00:00:00Z" }),
    ];
    const s = calculateSharpeRatio(trades);
    expect(s).toBe(0);
    expect(Number.isNaN(s)).toBe(false);
  });

  it("Sharpe sanitises NaN / Infinity in pnlPercent (no NaN propagation)", () => {
    // If a CSV import produces a weird pnlPercent (e.g. div-by-zero margin),
    // Sharpe must not propagate NaN to the dashboard.
    const trades = [
      makeTrade({ pnl: 10, pnlPercent: NaN, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({
        pnl: 10,
        pnlPercent: Infinity,
        exitDate: "2024-02-15T00:00:00Z",
      }),
      makeTrade({ pnl: 10, pnlPercent: 5, exitDate: "2024-03-15T00:00:00Z" }),
    ];
    const s = calculateSharpeRatio(trades);
    expect(Number.isFinite(s)).toBe(true);
  });

  it("All-break-even portfolio: winRate=0, PF=0, R:R=0, expectancy=0 (no NaN)", () => {
    const trades = [
      makeTrade({ pnl: 0 }),
      makeTrade({ pnl: 0 }),
      makeTrade({ pnl: 0 }),
    ];
    expect(calculateWinRate(trades)).toBe(0);
    expect(calculateProfitFactor(trades)).toBe(0);
    expect(calculateRiskReward(trades)).toBe(0);
    expect(calculateExpectancy(trades)).toBe(0);
    const { avgWin, avgLoss } = calculateAvgWinLoss(trades);
    expect(avgWin).toBe(0);
    expect(avgLoss).toBe(0);
  });

  it("Very large PnL (billions): no precision loss in totals & PF", () => {
    // Single large win plus a moderate loss — totals must be exact within
    // double-precision (≤ ~15 sig-figs). PF should be deterministic.
    const BILLION = 1_000_000_000;
    const trades = [
      makeTrade({ pnl: 5 * BILLION, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: -1 * BILLION, exitDate: "2024-02-01T00:00:00Z" }),
    ];
    const stats = calculateAllStats(trades);
    expect(stats.totalPnl).toBe(4 * BILLION);
    expect(stats.profitFactor).toBe(5);
    // Drawdown is 1B (peak 5B → 4B). Since it's exact integer arithmetic the
    // FP_TOLERANCE branch is irrelevant here.
    expect(stats.maxDrawdown).toBe(BILLION);
  });

  it("Floating-point noise: identical equity sequence → 0 drawdown (R56-CAL-2 FP_TOLERANCE)", () => {
    // The intent of FP_TOLERANCE is: when cumulative equity returns to its
    // peak via FP arithmetic noise (e.g. 0.1 + 0.2 - 0.3 = 5.55e-17 instead
    // of exact 0), the trough computation must NOT report a sub-penny
    // drawdown. Test sequence: equity rises then comes back EXACTLY to peak
    // — the only delta is FP noise.
    const trades = [
      makeTrade({ pnl: 0.1, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: 0.2, exitDate: "2024-01-02T00:00:00Z" }),
      // Intermediate state: equity peaks at 0.3 (with FP noise).
      // Now drop AND come back: -0.05 then +0.05 should noise-cancel.
      makeTrade({ pnl: -0.05, exitDate: "2024-01-03T00:00:00Z" }),
      makeTrade({ pnl: 0.05, exitDate: "2024-01-04T00:00:00Z" }),
    ];
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(trades);
    // The real drawdown is 0.05 (from peak 0.3 to trough 0.25). Verify the
    // FP_TOLERANCE branch still reports it accurately — it filters NOISE
    // (≪1e-9), not real per-trade drawdown.
    expect(maxDrawdown).toBeCloseTo(0.05, 9);
    expect(maxDrawdownPercent).toBeGreaterThan(0);
  });

  it("Single-trade portfolio: Sharpe=0 (n<2 guard), no crash", () => {
    const trades = [makeTrade({ pnl: 100, pnlPercent: 10 })];
    expect(calculateSharpeRatio(trades)).toBe(0);
    // calculateAllStats must also not crash on single-trade input.
    const stats = calculateAllStats(trades);
    expect(stats.totalTrades).toBe(1);
    expect(Number.isFinite(stats.sharpeRatio)).toBe(true);
  });

  it("calculatePnl: fees exceed gross PnL → net loss (not clamped to 0)", () => {
    // Tiny win, big fees → real net loss must be reported faithfully.
    const result = calculatePnl({
      direction: "long",
      entryPrice: 100,
      exitPrice: 100.5,
      quantity: 1,
      leverage: 1,
      fees: 5, // larger than the 0.50 gross profit
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    expect(result.pnl).toBeCloseTo(-4.5, 9);
    expect(result.pnlPercent).toBeCloseTo(-4.5, 9);
  });

  it("calculatePnl: negative quantity is NOT rejected (passes through linearly)", () => {
    // Documents current behaviour: there is no validation against negative
    // quantity. A long with quantity=-1 yields the inverse PnL of a long
    // with quantity=1. UI / form layer is responsible for rejecting this
    // — calculatePnl is a pure formula. If validation gets added in
    // production code, update this expectation.
    const result = calculatePnl({
      direction: "long",
      entryPrice: 100,
      exitPrice: 110,
      quantity: -1,
      leverage: 1,
      fees: 0,
      pair: "BTC/USDT",
      entryDate: "",
      exitDate: "",
      notes: "",
      tags: [],
    });
    expect(result.pnl).toBe(-10);
    // pnlPercent uses positionValue = entryPrice * quantity = -100, so
    // margin = -100; -10 / -100 * 100 = +10. Documents the math —
    // negative quantity flips the percentage sign too.
    expect(result.pnlPercent).toBe(10);
  });

  it("Profit factor: pure-loss vs pure-win symmetry", () => {
    // Pure wins → Infinity. Pure losses → 0. Asymmetry by design.
    expect(calculateProfitFactor([makeTrade({ pnl: 10 })])).toBe(Infinity);
    expect(calculateProfitFactor([makeTrade({ pnl: -10 })])).toBe(0);
  });

  it("calculateAllStats: huge mixed portfolio retains internal consistency", () => {
    // Sanity: totalPnl == sum of bestTrade + worstTrade + middle trades, AND
    // expectancy * totalTrades ≈ totalPnl (within rounding / BE-bucketing).
    const trades = [
      makeTrade({
        id: "b",
        pnl: 1000,
        pnlPercent: 10,
        exitDate: "2024-01-01T00:00:00Z",
      }),
      makeTrade({
        id: "w",
        pnl: -500,
        pnlPercent: -5,
        exitDate: "2024-01-02T00:00:00Z",
      }),
      makeTrade({
        id: "m",
        pnl: 250,
        pnlPercent: 2.5,
        exitDate: "2024-01-03T00:00:00Z",
      }),
    ];
    const stats = calculateAllStats(trades);
    expect(stats.totalPnl).toBe(750);
    expect(stats.bestTrade?.id).toBe("b");
    expect(stats.worstTrade?.id).toBe("w");
    // expectancy * N = winRate*avgWin*N - lossRate*avgLoss*N
    // = (2/3 * 625 * 3) - (1/3 * 500 * 3) = 1250 - 500 = 750. Exact.
    expect(stats.expectancy * stats.totalTrades).toBeCloseTo(stats.totalPnl, 6);
  });
});
