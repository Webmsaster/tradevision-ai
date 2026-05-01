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
  it("returns Infinity when only wins (semantically correct — undefined R:R)", () => {
    const trades = [makeTrade({ pnl: 10 })];
    expect(calculateRiskReward(trades)).toBe(Infinity);
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
    expect(curve[0].equity).toBe(10);
    expect(curve[0].drawdown).toBe(0);
    expect(curve[1].equity).toBe(5);
    expect(curve[1].drawdown).toBe(5);
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
    const trades = [
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: 15 }),
    ];
    expect(calculateSharpeRatio(trades)).toBeGreaterThan(0);
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
    const trades = [
      makeTrade({ pnl: 10, entryDate: "2024-01-01T09:00:00" }),
      makeTrade({ pnl: -5, entryDate: "2024-01-02T09:30:00" }),
      makeTrade({ pnl: 20, entryDate: "2024-01-01T14:00:00" }),
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
