import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TradeDetailModal from "@/components/TradeDetailModal";
import { Trade } from "@/types/trade";

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "t1",
    pair: "BTC/USDT",
    direction: "long",
    entryPrice: 50000,
    exitPrice: 52000,
    quantity: 0.5,
    entryDate: "2026-01-01T10:00:00Z",
    exitDate: "2026-01-02T14:30:00Z",
    pnl: 1000,
    pnlPercent: 4,
    fees: 10,
    notes: "",
    tags: [],
    leverage: 2,
    ...overrides,
  };
}

describe("TradeDetailModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <TradeDetailModal trade={makeTrade()} isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when trade is null", () => {
    const { container } = render(
      <TradeDetailModal trade={null} isOpen onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders pair and direction when open", () => {
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={vi.fn()} />);
    expect(screen.getByText("BTC/USDT")).toBeInTheDocument();
    expect(screen.getByText("LONG")).toBeInTheDocument();
  });

  it("renders SHORT for short direction", () => {
    render(
      <TradeDetailModal
        trade={makeTrade({ direction: "short" })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("SHORT")).toBeInTheDocument();
  });

  it("renders entry, exit, quantity, leverage, fees", () => {
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={vi.fn()} />);
    expect(screen.getByText("Entry Price")).toBeInTheDocument();
    expect(screen.getByText("Exit Price")).toBeInTheDocument();
    expect(screen.getByText("Quantity")).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
    expect(screen.getByText("2x")).toBeInTheDocument();
  });

  it("calls onClose when Escape pressed", () => {
    const onClose = vi.fn();
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when close (X) button clicked", () => {
    const onClose = vi.fn();
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when overlay clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <TradeDetailModal trade={makeTrade()} isOpen onClose={onClose} />,
    );
    // Phase 60 (R45-UI-L2): overlay close moved from `onClick` to
    // `onMouseDown` to avoid closing when text-selection released on
    // the overlay; trigger the right event in the test.
    fireEvent.mouseDown(container.querySelector(".modal-overlay")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when modal content clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <TradeDetailModal trade={makeTrade()} isOpen onClose={onClose} />,
    );
    // Phase 60: overlay listens to mouseDown now; mouseDown on modal-content
    // bubbles to overlay but `e.target !== e.currentTarget` so onClose stays.
    fireEvent.mouseDown(container.querySelector(".modal-content")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when footer Close button clicked", () => {
    const onClose = vi.fn();
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders journal entry section when fields present", () => {
    render(
      <TradeDetailModal
        trade={makeTrade({
          emotion: "confident",
          confidence: 4,
          setupType: "breakout",
          timeframe: "1h",
          marketCondition: "trending",
        })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Journal Entry")).toBeInTheDocument();
    expect(screen.getByText("Confident")).toBeInTheDocument();
    expect(screen.getByText("breakout")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getByText("trending")).toBeInTheDocument();
  });

  it("hides journal entry section when no journal fields set", () => {
    render(<TradeDetailModal trade={makeTrade()} isOpen onClose={vi.fn()} />);
    expect(screen.queryByText("Journal Entry")).not.toBeInTheDocument();
  });

  it("renders tags when present", () => {
    render(
      <TradeDetailModal
        trade={makeTrade({ tags: ["momentum", "earnings"] })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("momentum")).toBeInTheDocument();
    expect(screen.getByText("earnings")).toBeInTheDocument();
  });

  it("renders notes when present", () => {
    render(
      <TradeDetailModal
        trade={makeTrade({ notes: "Clean breakout on volume" })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Clean breakout on volume")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("renders screenshot img when present", () => {
    render(
      <TradeDetailModal
        trade={makeTrade({ screenshot: "data:image/png;base64,abc" })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    const img = screen.getByAltText(/BTC\/USDT trade chart/);
    expect(img).toBeInTheDocument();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,abc");
  });

  it("has proper modal aria attributes", () => {
    const { container } = render(
      <TradeDetailModal trade={makeTrade()} isOpen onClose={vi.fn()} />,
    );
    const overlay = container.querySelector('[role="dialog"]');
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(overlay).toHaveAttribute("aria-labelledby", "trade-detail-title");
  });

  it("locks body scroll when open, restores on close", () => {
    const { unmount } = render(
      <TradeDetailModal trade={makeTrade()} isOpen onClose={vi.fn()} />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
