import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import WeeklySummary from "@/components/WeeklySummary";
import { Trade } from "@/types/trade";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
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

describe("WeeklySummary", () => {
  it("renders empty-state message when no trades", () => {
    render(<WeeklySummary trades={[]} />);
    expect(
      screen.getByText("Need more data for weekly comparison"),
    ).toBeInTheDocument();
  });

  it("renders empty-state message when fewer than 2 distinct weeks", () => {
    const trades = [
      makeTrade({ exitDate: "2026-01-05T12:00:00Z", pnl: 50 }),
      makeTrade({ exitDate: "2026-01-06T12:00:00Z", pnl: 30 }),
    ];
    render(<WeeklySummary trades={trades} />);
    expect(
      screen.getByText("Need more data for weekly comparison"),
    ).toBeInTheDocument();
  });

  it("renders weekly rows when 2+ distinct weeks present", () => {
    const trades = [
      makeTrade({ exitDate: "2026-01-05T12:00:00Z", pnl: 100 }),
      makeTrade({ exitDate: "2026-01-12T12:00:00Z", pnl: -50 }),
      makeTrade({ exitDate: "2026-01-13T12:00:00Z", pnl: 25 }),
    ];
    const { container } = render(<WeeklySummary trades={trades} />);
    expect(screen.getByText("Weekly Performance")).toBeInTheDocument();
    const rows = container.querySelectorAll(".weekly-row");
    expect(rows.length).toBe(2);
  });

  it("formats positive PnL with + prefix", () => {
    const trades = [
      makeTrade({ exitDate: "2026-01-05T12:00:00Z", pnl: 100 }),
      makeTrade({ exitDate: "2026-01-12T12:00:00Z", pnl: 250 }),
    ];
    render(<WeeklySummary trades={trades} />);
    expect(screen.getByText(/\+\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$250\.00/)).toBeInTheDocument();
  });

  it("formats negative PnL with - prefix", () => {
    const trades = [
      makeTrade({ exitDate: "2026-01-05T12:00:00Z", pnl: -100 }),
      makeTrade({ exitDate: "2026-01-12T12:00:00Z", pnl: -50 }),
    ];
    render(<WeeklySummary trades={trades} />);
    expect(screen.getByText(/-\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/-\$50\.00/)).toBeInTheDocument();
  });

  it("renders trade count and win rate meta", () => {
    const trades = [
      makeTrade({ exitDate: "2026-01-05T12:00:00Z", pnl: 10 }),
      makeTrade({ exitDate: "2026-01-05T14:00:00Z", pnl: -5 }),
      makeTrade({ exitDate: "2026-01-12T12:00:00Z", pnl: 20 }),
    ];
    render(<WeeklySummary trades={trades} />);
    expect(screen.getByText(/2 trades \| 50% win rate/)).toBeInTheDocument();
    expect(screen.getByText(/1 trade \| 100% win rate/)).toBeInTheDocument();
  });

  it("shows at most 8 weeks (slice)", () => {
    const trades: Trade[] = [];
    for (let i = 0; i < 12; i++) {
      trades.push(
        makeTrade({
          exitDate: `2026-${String(i + 1).padStart(2, "0")}-01T12:00:00Z`,
          pnl: 10,
        }),
      );
    }
    const { container } = render(<WeeklySummary trades={trades} />);
    expect(
      container.querySelectorAll(".weekly-row").length,
    ).toBeLessThanOrEqual(8);
  });
});
