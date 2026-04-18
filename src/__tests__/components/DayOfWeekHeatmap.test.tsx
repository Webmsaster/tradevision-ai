import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DayOfWeekHeatmap from "@/components/DayOfWeekHeatmap";
import { Trade } from "@/types/trade";

function t(overrides: Partial<Trade> = {}): Trade {
  return {
    id: Math.random().toString(36).slice(2),
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryDate: "2026-01-05T10:00:00Z",
    exitDate: "2026-01-05T12:00:00Z",
    pnl: 10,
    pnlPercent: 10,
    fees: 0,
    notes: "",
    tags: [],
    leverage: 1,
    ...overrides,
  };
}

describe("DayOfWeekHeatmap", () => {
  it("renders empty state when no trades", () => {
    render(<DayOfWeekHeatmap trades={[]} />);
    expect(screen.getByText("No trades to analyze yet")).toBeInTheDocument();
  });

  it("renders rows for each day of the week", () => {
    const trades = [t({ exitDate: "2026-01-05T12:00:00Z", pnl: 20 })];
    const { container } = render(<DayOfWeekHeatmap trades={trades} />);
    expect(container.querySelectorAll(".weekly-row").length).toBe(7);
  });

  it("shows total for days with trades and empty for other days", () => {
    const trades = [
      t({ exitDate: "2026-01-05T12:00:00Z", pnl: 30 }), // Monday
      t({ exitDate: "2026-01-06T12:00:00Z", pnl: -10 }), // Tuesday
    ];
    render(<DayOfWeekHeatmap trades={trades} />);
    expect(screen.getByText(/\+\$30\.00/)).toBeInTheDocument();
    expect(screen.getByText(/-\$10\.00/)).toBeInTheDocument();
    // Other days should show em-dash
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders day short labels", () => {
    const trades = [t({ exitDate: "2026-01-05T12:00:00Z", pnl: 10 })];
    render(<DayOfWeekHeatmap trades={trades} />);
    for (const l of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(screen.getByText(l)).toBeInTheDocument();
    }
  });
});
