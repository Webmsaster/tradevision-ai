import { describe, it, expect } from "vitest";
import type { Trade } from "@/types/trade";
import {
  detectRevengeTrade,
  detectHoldingLosers,
  detectTimePatterns,
  detectOverleverageAfterWins,
  detectLossAversion,
  detectTiltPattern,
  detectConsistentPair,
  detectGoodRiskManagement,
  detectOvertrading,
  detectWeekendTrading,
  detectImprovingPerformance,
  detectDecliningPerformance,
  detectPairSwitching,
  generateAllInsights,
} from "@/utils/aiAnalysis";

let idCounter = 0;

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  idCounter++;
  return {
    id: `trade-${idCounter}`,
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

describe("detectRevengeTrade", () => {
  it("returns null for fewer than 3 trades", () => {
    expect(detectRevengeTrade([makeTrade(), makeTrade()])).toBeNull();
  });

  it("detects revenge trading pattern", () => {
    const trades = [
      makeTrade({
        pnl: -10,
        quantity: 1,
        entryPrice: 100,
        exitDate: "2024-01-01T00:00:00Z",
      }),
      makeTrade({
        pnl: -15,
        quantity: 1,
        entryPrice: 100,
        exitDate: "2024-01-02T00:00:00Z",
      }),
      makeTrade({
        pnl: 5,
        quantity: 2,
        entryPrice: 100,
        exitDate: "2024-01-03T00:00:00Z",
      }),
      // Position size jumped from 100 to 200 (>50% increase)
    ];
    const result = detectRevengeTrade(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("revenge-trading");
  });

  it("returns null when position size does not increase", () => {
    const trades = [
      makeTrade({
        pnl: -10,
        quantity: 1,
        entryPrice: 100,
        exitDate: "2024-01-01T00:00:00Z",
      }),
      makeTrade({
        pnl: -15,
        quantity: 1,
        entryPrice: 100,
        exitDate: "2024-01-02T00:00:00Z",
      }),
      makeTrade({
        pnl: 5,
        quantity: 1,
        entryPrice: 100,
        exitDate: "2024-01-03T00:00:00Z",
      }),
    ];
    expect(detectRevengeTrade(trades)).toBeNull();
  });
});

describe("detectHoldingLosers", () => {
  it("returns null with insufficient trades", () => {
    expect(detectHoldingLosers([makeTrade()])).toBeNull();
  });

  it("detects when losers are held much longer than winners", () => {
    const trades = [
      makeTrade({
        pnl: 10,
        entryDate: "2024-01-01T10:00:00Z",
        exitDate: "2024-01-01T11:00:00Z",
      }), // 1h
      makeTrade({
        pnl: 20,
        entryDate: "2024-01-02T10:00:00Z",
        exitDate: "2024-01-02T11:00:00Z",
      }), // 1h
      makeTrade({
        pnl: -5,
        entryDate: "2024-01-03T10:00:00Z",
        exitDate: "2024-01-03T14:00:00Z",
      }), // 4h
      makeTrade({
        pnl: -10,
        entryDate: "2024-01-04T10:00:00Z",
        exitDate: "2024-01-04T14:00:00Z",
      }), // 4h
    ];
    const result = detectHoldingLosers(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("loss-aversion");
  });
});

describe("detectTimePatterns", () => {
  it("returns null for fewer than 3 trades", () => {
    expect(detectTimePatterns([makeTrade()])).toBeNull();
  });

  it("detects poor performance at specific hour", () => {
    // 3 losing trades at 10:00 hour
    const trades = [
      makeTrade({ pnl: -5, entryDate: "2024-01-01T10:30:00Z" }),
      makeTrade({ pnl: -10, entryDate: "2024-01-02T10:15:00Z" }),
      makeTrade({ pnl: -3, entryDate: "2024-01-03T10:45:00Z" }),
    ];
    const result = detectTimePatterns(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("time-patterns");
  });
});

describe("detectOverleverageAfterWins", () => {
  it("returns null for fewer than 4 trades", () => {
    expect(
      detectOverleverageAfterWins([makeTrade(), makeTrade(), makeTrade()]),
    ).toBeNull();
  });

  it("detects leverage increase after winning streak", () => {
    const trades = [
      makeTrade({ pnl: 10, leverage: 2, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: 15, leverage: 2, exitDate: "2024-01-02T00:00:00Z" }),
      makeTrade({ pnl: 20, leverage: 2, exitDate: "2024-01-03T00:00:00Z" }),
      makeTrade({ pnl: -30, leverage: 5, exitDate: "2024-01-04T00:00:00Z" }),
      // Leverage jumped from avg 2x to 5x (>150% increase)
    ];
    const result = detectOverleverageAfterWins(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("overleverage");
  });
});

describe("detectLossAversion", () => {
  it("returns null with insufficient trades", () => {
    expect(detectLossAversion([makeTrade()])).toBeNull();
  });

  it("detects when avg loss exceeds avg win by >1.5x", () => {
    const trades = [
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: 10 }),
      makeTrade({ pnl: -25 }),
      makeTrade({ pnl: -25 }),
      makeTrade({ pnl: -25 }),
    ];
    // avgWin=10, avgLoss=25, ratio=2.5x
    const result = detectLossAversion(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("loss-aversion");
  });
});

describe("detectTiltPattern", () => {
  it("returns null for fewer than 6 trades", () => {
    const trades = Array.from({ length: 5 }, () => makeTrade());
    expect(detectTiltPattern(trades)).toBeNull();
  });

  it("detects tilt after drawdown", () => {
    const trades = [
      makeTrade({ pnl: 100, exitDate: "2024-01-01T00:00:00Z" }),
      makeTrade({ pnl: -20, exitDate: "2024-01-02T00:00:00Z" }),
      // Running: 100, 80. Peak: 100. Drawdown: 20% > 5%
      // Next 5 trades: 4 losses, 1 win = 20% win rate < 30%
      makeTrade({ pnl: -5, exitDate: "2024-01-03T00:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-04T00:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-05T00:00:00Z" }),
      makeTrade({ pnl: 5, exitDate: "2024-01-06T00:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-07T00:00:00Z" }),
    ];
    const result = detectTiltPattern(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("tilt");
  });
});

describe("detectConsistentPair", () => {
  it("returns null for fewer than 5 trades", () => {
    expect(detectConsistentPair([makeTrade()])).toBeNull();
  });

  it("detects consistently profitable pair", () => {
    const trades = [
      makeTrade({ pair: "BTC/USDT", pnl: 10 }),
      makeTrade({ pair: "BTC/USDT", pnl: 20 }),
      makeTrade({ pair: "BTC/USDT", pnl: 15 }),
      makeTrade({ pair: "BTC/USDT", pnl: 5 }),
      makeTrade({ pair: "BTC/USDT", pnl: 10 }),
    ];
    const result = detectConsistentPair(trades);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("positive");
  });
});

describe("detectOvertrading", () => {
  it("detects too many trades in a day with low win rate", () => {
    const trades = [
      makeTrade({ pnl: -5, exitDate: "2024-01-15T10:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-15T11:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-15T12:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-15T13:00:00Z" }),
      makeTrade({ pnl: 5, exitDate: "2024-01-15T14:00:00Z" }),
      makeTrade({ pnl: -5, exitDate: "2024-01-15T15:00:00Z" }),
    ];
    const result = detectOvertrading(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("overtrading");
  });
});

describe("detectWeekendTrading", () => {
  it("returns null when weekend ratio is low", () => {
    const trades = [
      makeTrade({ exitDate: "2024-01-08T10:00:00Z" }), // Mon
      makeTrade({ exitDate: "2024-01-09T10:00:00Z" }), // Tue
      makeTrade({ exitDate: "2024-01-10T10:00:00Z" }), // Wed
      makeTrade({ exitDate: "2024-01-11T10:00:00Z" }), // Thu
      makeTrade({ exitDate: "2024-01-12T10:00:00Z" }), // Fri
    ];
    expect(detectWeekendTrading(trades)).toBeNull();
  });
});

// Phase 21 (AI Bug 7): minimum sample bumped to 20 trades to reduce
// 33%-quantization-noise false-positives at small N.
function makeImprovingHalves(): Trade[] {
  const trades: Trade[] = [];
  // First half (10): 3 wins = 30%
  for (let i = 0; i < 10; i++) {
    trades.push(
      makeTrade({
        pnl: i < 3 ? 10 : -5,
        exitDate: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
  }
  // Second half (10): 9 wins = 90%
  for (let i = 0; i < 10; i++) {
    trades.push(
      makeTrade({
        pnl: i < 9 ? 10 : -5,
        exitDate: `2024-01-${String(i + 11).padStart(2, "0")}T00:00:00Z`,
      }),
    );
  }
  return trades;
}

describe("detectImprovingPerformance", () => {
  it("detects improving win rate (≥20 trades)", () => {
    const result = detectImprovingPerformance(makeImprovingHalves());
    expect(result).not.toBeNull();
    expect(result!.type).toBe("positive");
  });
});

describe("detectDecliningPerformance", () => {
  it("detects declining win rate (≥20 trades)", () => {
    // Reverse the improving fixture: first half 90% wins, second half 30%.
    const declining = makeImprovingHalves()
      .reverse()
      .map((t, i) => ({
        ...t,
        exitDate: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }));
    const result = detectDecliningPerformance(declining);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("warning");
  });
});

describe("detectPairSwitching", () => {
  it("returns null for fewer than 10 trades", () => {
    expect(
      detectPairSwitching(Array.from({ length: 5 }, () => makeTrade())),
    ).toBeNull();
  });

  it("detects frequent pair switching", () => {
    const pairs = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT", "XRP/USDT"];
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTrade({
        pair: pairs[i % pairs.length],
        exitDate: `2024-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const result = detectPairSwitching(trades);
    expect(result).not.toBeNull();
    expect(result!.category).toBe("pair-switching");
  });
});

describe("detectGoodRiskManagement", () => {
  it("returns null for fewer than 5 trades", () => {
    const trades = Array.from({ length: 4 }, () => makeTrade({ pnl: 10 }));
    expect(detectGoodRiskManagement(trades)).toBeNull();
  });

  it("returns positive insight when all trades are winners (grossLoss === 0)", () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({ pnl: 10, exitDate: `2024-01-0${i + 1}T10:00:00Z` }),
    );
    const result = detectGoodRiskManagement(trades);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("positive");
    expect(result!.title).toBe("Excellent Risk Management");
  });

  it("returns positive insight for good profit factor and small max loss", () => {
    const trades = [
      makeTrade({ pnl: 100, exitDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ pnl: 80, exitDate: "2024-01-02T10:00:00Z" }),
      makeTrade({ pnl: 60, exitDate: "2024-01-03T10:00:00Z" }),
      makeTrade({ pnl: -2, exitDate: "2024-01-04T10:00:00Z" }),
      makeTrade({ pnl: -1, exitDate: "2024-01-05T10:00:00Z" }),
    ];
    const result = detectGoodRiskManagement(trades);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("positive");
    expect(result!.title).toBe("Strong Risk Management");
  });

  it("returns null when profit factor is low", () => {
    const trades = [
      makeTrade({ pnl: 10, exitDate: "2024-01-01T10:00:00Z" }),
      makeTrade({ pnl: -20, exitDate: "2024-01-02T10:00:00Z" }),
      makeTrade({ pnl: 5, exitDate: "2024-01-03T10:00:00Z" }),
      makeTrade({ pnl: -15, exitDate: "2024-01-04T10:00:00Z" }),
      makeTrade({ pnl: -10, exitDate: "2024-01-05T10:00:00Z" }),
    ];
    expect(detectGoodRiskManagement(trades)).toBeNull();
  });
});

describe("generateAllInsights", () => {
  it("returns empty array for empty trades", () => {
    expect(generateAllInsights([])).toEqual([]);
  });

  it("returns insights sorted by severity descending", () => {
    // Create trades that trigger multiple detectors
    const trades = [
      makeTrade({
        pnl: 100,
        exitDate: "2024-01-01T00:00:00Z",
        pair: "BTC/USDT",
      }),
      makeTrade({
        pnl: -20,
        exitDate: "2024-01-02T00:00:00Z",
        pair: "BTC/USDT",
      }),
      makeTrade({
        pnl: -5,
        exitDate: "2024-01-03T00:00:00Z",
        pair: "BTC/USDT",
      }),
      makeTrade({
        pnl: -5,
        exitDate: "2024-01-04T00:00:00Z",
        pair: "BTC/USDT",
      }),
      makeTrade({
        pnl: -5,
        exitDate: "2024-01-05T00:00:00Z",
        pair: "BTC/USDT",
      }),
      makeTrade({ pnl: 5, exitDate: "2024-01-06T00:00:00Z", pair: "BTC/USDT" }),
      makeTrade({
        pnl: -5,
        exitDate: "2024-01-07T00:00:00Z",
        pair: "BTC/USDT",
      }),
    ];
    const insights = generateAllInsights(trades);
    for (let i = 1; i < insights.length; i++) {
      expect(insights[i - 1].severity).toBeGreaterThanOrEqual(
        insights[i].severity,
      );
    }
  });
});
