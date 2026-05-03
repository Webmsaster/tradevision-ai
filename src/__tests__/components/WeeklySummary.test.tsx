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

  // Round 56 fix #3: ISO-week computation must be UTC-only so users in
  // different timezones see the same weekly grouping. Sunday-late-UTC
  // trades (which become Monday in TZs west of UTC) belong in the
  // earlier ISO week.
  it("groups trades into UTC ISO-weeks regardless of host TZ", () => {
    // 2026-01-04 (Sunday, ISO-W01) and 2026-01-05 (Monday, ISO-W02) span
    // an ISO-week boundary in UTC. They MUST end up in different buckets.
    // Add a third week to satisfy ≥2-weeks gate AND show separation works.
    const trades = [
      // Sunday 23:30 UTC — ISO-week 1 of 2026.
      makeTrade({ exitDate: "2026-01-04T23:30:00Z", pnl: 100 }),
      // Monday 00:30 UTC — ISO-week 2 of 2026.
      makeTrade({ exitDate: "2026-01-05T00:30:00Z", pnl: -50 }),
      // Same ISO-week 2.
      makeTrade({ exitDate: "2026-01-08T12:00:00Z", pnl: 25 }),
    ];
    const { container } = render(<WeeklySummary trades={trades} />);
    const rows = container.querySelectorAll(".weekly-row");
    // Should produce exactly 2 distinct ISO-weeks (W01 and W02).
    expect(rows.length).toBe(2);
    // Week 1 totalPnl = +$100 (the Sunday 23:30 UTC trade).
    expect(screen.getByText(/\+\$100\.00/)).toBeInTheDocument();
    // Week 2 totalPnl = -$50 + $25 = -$25.
    expect(screen.getByText(/-\$25\.00/)).toBeInTheDocument();
  });
});
