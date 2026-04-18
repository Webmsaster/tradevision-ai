import { describe, it, expect } from "vitest";
import {
  detectEmotionalPerformance,
  detectBestSetup,
  detectFeeDrag,
  detectDayOfWeekBias,
} from "@/utils/aiAnalysis";
import { Trade } from "@/types/trade";

function t(overrides: Partial<Trade>): Trade {
  return {
    id: Math.random().toString(36).slice(2),
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 100,
    quantity: 1,
    entryDate: "2026-01-05T10:00:00Z",
    exitDate: "2026-01-05T12:00:00Z",
    pnl: 0,
    pnlPercent: 0,
    fees: 0,
    notes: "",
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

describe("detectEmotionalPerformance", () => {
  it("returns null with fewer than 5 emotion-tagged trades", () => {
    const trades = [
      t({ emotion: "fomo", pnl: -10 }),
      t({ emotion: "confident", pnl: 5 }),
    ];
    expect(detectEmotionalPerformance(trades)).toBeNull();
  });

  it("flags warning when emotional trades underperform by 15pp+", () => {
    const trades = [
      ...Array.from({ length: 4 }, () => t({ emotion: "fomo", pnl: -10 })),
      ...Array.from({ length: 4 }, () => t({ emotion: "confident", pnl: 15 })),
    ];
    const insight = detectEmotionalPerformance(trades);
    expect(insight).not.toBeNull();
    expect(insight!.type).toBe("warning");
    expect(insight!.category).toBe("emotional-discipline");
  });

  it("returns null when gap is small", () => {
    const trades = [
      ...Array.from({ length: 4 }, () => t({ emotion: "fomo", pnl: 10 })),
      ...Array.from({ length: 4 }, () => t({ emotion: "confident", pnl: 11 })),
    ];
    expect(detectEmotionalPerformance(trades)).toBeNull();
  });
});

describe("detectBestSetup", () => {
  it("returns null without enough setups", () => {
    const trades = [t({ setupType: "breakout", pnl: 10 })];
    expect(detectBestSetup(trades)).toBeNull();
  });

  it("flags best setup when it clearly outperforms others", () => {
    const trades = [
      ...Array.from({ length: 4 }, () => t({ setupType: "breakout", pnl: 50 })),
      ...Array.from({ length: 4 }, () => t({ setupType: "pullback", pnl: 5 })),
      ...Array.from({ length: 4 }, () => t({ setupType: "reversal", pnl: -5 })),
    ];
    const insight = detectBestSetup(trades);
    expect(insight).not.toBeNull();
    expect(insight!.type).toBe("positive");
    expect(insight!.title.toLowerCase()).toContain("breakout");
  });

  it("returns null if best setup is not positive", () => {
    const trades = [
      ...Array.from({ length: 4 }, () => t({ setupType: "a", pnl: -5 })),
      ...Array.from({ length: 4 }, () => t({ setupType: "b", pnl: -10 })),
    ];
    expect(detectBestSetup(trades)).toBeNull();
  });
});

describe("detectFeeDrag", () => {
  it("returns null when fees are negligible", () => {
    const trades = Array.from({ length: 5 }, () => t({ pnl: 100, fees: 1 }));
    expect(detectFeeDrag(trades)).toBeNull();
  });

  it("flags warning when fees exceed 20% of gross wins", () => {
    const trades = [
      ...Array.from({ length: 5 }, () => t({ pnl: 10, fees: 5 })),
      ...Array.from({ length: 2 }, () => t({ pnl: -5, fees: 2 })),
    ];
    const insight = detectFeeDrag(trades);
    expect(insight).not.toBeNull();
    expect(insight!.type).toBe("warning");
    expect(insight!.category).toBe("fee-drag");
  });

  it("returns null when no winning trades", () => {
    const trades = Array.from({ length: 5 }, () => t({ pnl: -10, fees: 5 }));
    expect(detectFeeDrag(trades)).toBeNull();
  });
});

describe("detectDayOfWeekBias", () => {
  it("returns null with fewer than 10 trades", () => {
    expect(detectDayOfWeekBias([])).toBeNull();
  });

  it("flags warning when worst weekday is notably negative", () => {
    // Monday = 2026-01-05, Tuesday = 2026-01-06
    const trades = [
      ...Array.from({ length: 5 }, () =>
        t({ exitDate: "2026-01-05T12:00:00Z", pnl: 10 }),
      ),
      ...Array.from({ length: 5 }, () =>
        t({ exitDate: "2026-01-06T12:00:00Z", pnl: -40 }),
      ),
    ];
    const insight = detectDayOfWeekBias(trades);
    expect(insight).not.toBeNull();
    expect(insight!.category).toBe("day-of-week-bias");
  });
});
