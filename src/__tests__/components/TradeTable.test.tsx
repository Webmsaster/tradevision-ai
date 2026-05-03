import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TradeTable from "@/components/TradeTable";
import { Trade } from "@/types/trade";

// Mock TradeDetailModal to avoid rendering complexity
vi.mock("@/components/TradeDetailModal", () => ({
  default: ({ isOpen, trade }: { isOpen: boolean; trade: Trade | null }) =>
    isOpen ? <div data-testid="trade-detail-modal">{trade?.pair}</div> : null,
}));

const makeTrade = (overrides: Partial<Trade> = {}): Trade => ({
  id: "1",
  pair: "BTC/USDT",
  direction: "long",
  entryPrice: 40000,
  exitPrice: 42000,
  quantity: 1,
  entryDate: "2026-01-01T00:00:00Z",
  exitDate: "2026-01-02T00:00:00Z",
  pnl: 2000,
  pnlPercent: 5,
  fees: 10,
  leverage: 1,
  notes: "",
  tags: [],
  ...overrides,
});

const sampleTrades: Trade[] = [
  makeTrade({
    id: "1",
    pair: "BTC/USDT",
    pnl: 2000,
    pnlPercent: 5,
    exitDate: "2026-01-02T00:00:00Z",
  }),
  makeTrade({
    id: "2",
    pair: "ETH/USDT",
    pnl: -500,
    pnlPercent: -2.5,
    direction: "short",
    exitDate: "2026-01-03T00:00:00Z",
  }),
  makeTrade({
    id: "3",
    pair: "SOL/USDT",
    pnl: 300,
    pnlPercent: 1.2,
    exitDate: "2026-01-01T00:00:00Z",
  }),
];

describe("TradeTable", () => {
  it("renders empty state when no trades", () => {
    render(<TradeTable trades={[]} />);
    expect(screen.getByText(/No trades to display/)).toBeInTheDocument();
  });

  it("renders trade rows", () => {
    render(<TradeTable trades={sampleTrades} />);
    expect(screen.getByText("BTC/USDT")).toBeInTheDocument();
    expect(screen.getByText("ETH/USDT")).toBeInTheDocument();
    expect(screen.getByText("SOL/USDT")).toBeInTheDocument();
  });

  it("renders direction badges", () => {
    render(<TradeTable trades={sampleTrades} />);
    const longs = screen.getAllByText("LONG");
    const shorts = screen.getAllByText("SHORT");
    expect(longs.length).toBe(2);
    expect(shorts.length).toBe(1);
  });

  it("renders column headers with sort functionality", () => {
    render(<TradeTable trades={sampleTrades} />);
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByText("Pair")).toBeInTheDocument();
    expect(screen.getByText("PnL ($)")).toBeInTheDocument();
  });

  it("sorts by pair when clicking Pair header", { timeout: 15000 }, () => {
    render(<TradeTable trades={sampleTrades} />);
    const pairHeader = screen.getByText("Pair");
    fireEvent.click(pairHeader);

    const rows = screen.getAllByRole("row");
    // First row is header, second should be first sorted trade
    const cells = rows[1]!.querySelectorAll("td");
    expect(cells[1]!.textContent).toBe("BTC/USDT");
  });

  it("toggles sort direction on second click", () => {
    render(<TradeTable trades={sampleTrades} />);
    const pairHeader = screen.getByText("Pair");

    // First click: asc
    fireEvent.click(pairHeader);
    // Second click: desc
    fireEvent.click(pairHeader);

    const rows = screen.getAllByRole("row");
    const cells = rows[1]!.querySelectorAll("td");
    expect(cells[1]!.textContent).toBe("SOL/USDT");
  });

  it("supports keyboard sort (Enter key)", () => {
    render(<TradeTable trades={sampleTrades} />);
    const pairHeader = screen.getByText("Pair");
    fireEvent.keyDown(pairHeader, { key: "Enter" });

    const header = pairHeader.closest("th");
    expect(header?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("calls onEdit when edit button clicked", () => {
    const onEdit = vi.fn();
    render(<TradeTable trades={sampleTrades} onEdit={onEdit} />);
    const editButtons = screen.getAllByTitle("Edit trade");
    fireEvent.click(editButtons[0]!);
    // Default sort is exitDate desc, so first row is the trade with latest exitDate (id: 2)
    expect(onEdit).toHaveBeenCalledWith(sampleTrades[1]);
  });

  it("calls onDelete when delete button clicked", () => {
    const onDelete = vi.fn();
    render(<TradeTable trades={sampleTrades} onDelete={onDelete} />);
    const deleteButtons = screen.getAllByTitle("Delete trade");
    fireEvent.click(deleteButtons[0]!);
    expect(onDelete).toHaveBeenCalledWith(sampleTrades[1]!.id);
  });

  it("opens detail modal on row click", () => {
    render(<TradeTable trades={sampleTrades} />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]!); // click first data row
    expect(screen.getByTestId("trade-detail-modal")).toBeInTheDocument();
  });

  it("opens detail modal on row Enter key", () => {
    render(<TradeTable trades={sampleTrades} />);
    const rows = screen.getAllByRole("row");
    fireEvent.keyDown(rows[1]!, { key: "Enter" });
    expect(screen.getByTestId("trade-detail-modal")).toBeInTheDocument();
  });

  it("hides extra columns in compact mode", () => {
    render(<TradeTable trades={sampleTrades} compact />);
    expect(screen.queryByText("Entry")).not.toBeInTheDocument();
    expect(screen.queryByText("Exit")).not.toBeInTheDocument();
    expect(screen.queryByText("Qty")).not.toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("shows pagination when more than 25 trades", () => {
    const manyTrades = Array.from({ length: 30 }, (_, i) =>
      makeTrade({
        id: String(i),
        pair: `PAIR${i}/USDT`,
        exitDate: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    render(<TradeTable trades={manyTrades} />);
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
  });

  it("navigates pages", () => {
    const manyTrades = Array.from({ length: 30 }, (_, i) =>
      makeTrade({
        id: String(i),
        pair: `PAIR${i}/USDT`,
        exitDate: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    render(<TradeTable trades={manyTrades} />);
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });
});
