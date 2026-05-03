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

  // Round 56 fix #2: bucket on getUTCDay so a Sunday 23:00 UTC trade is
  // booked on Sunday for ALL users — previously getDay() shifted it to
  // Monday for users east of UTC and Saturday for users west of UTC.
  it("buckets trades by UTC day-of-week (not local TZ)", () => {
    // 2026-01-04 is a Sunday in UTC.
    const trades = [t({ exitDate: "2026-01-04T23:30:00Z", pnl: 42 })];
    const { container } = render(<DayOfWeekHeatmap trades={trades} />);
    // Find the Sun row by short label and check its sibling shows the PnL.
    expect(screen.getByText("Sun")).toBeInTheDocument();
    expect(screen.getByText(/\+\$42\.00/)).toBeInTheDocument();
    // Other six days should be empty (em-dash).
    const dashes = container.querySelectorAll(".weekly-pnl");
    const dashCount = Array.from(dashes).filter(
      (n) => n.textContent === "—",
    ).length;
    expect(dashCount).toBe(6);
  });
});
