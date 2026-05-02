import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TradeForm from "@/components/TradeForm";
import { Trade } from "@/types/trade";

// Mock useFocusTrap
vi.mock("@/hooks/useFocusTrap", () => ({
  useFocusTrap: () => ({ current: null }),
}));

const mockOnSubmit = vi.fn();
const mockOnClose = vi.fn();

const defaultProps = {
  isOpen: true,
  onClose: mockOnClose,
  onSubmit: mockOnSubmit,
};

const editTrade: Trade = {
  id: "test-1",
  pair: "BTC/USDT",
  direction: "long",
  entryPrice: 40000,
  exitPrice: 42000,
  quantity: 1,
  entryDate: "2026-01-01T10:00:00.000Z",
  exitDate: "2026-01-02T10:00:00.000Z",
  pnl: 2000,
  pnlPercent: 5,
  fees: 10,
  leverage: 2,
  notes: "Test note",
  tags: ["scalp", "momentum"],
};

describe("TradeForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <TradeForm {...defaultProps} isOpen={false} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders form when open", () => {
    render(<TradeForm {...defaultProps} />);
    expect(screen.getByText("Add New Trade")).toBeInTheDocument();
  });

  it('shows "Edit Trade" title when editing', () => {
    render(<TradeForm {...defaultProps} editTrade={editTrade} />);
    expect(screen.getByText("Edit Trade")).toBeInTheDocument();
  });

  it("populates fields when editing", () => {
    render(<TradeForm {...defaultProps} editTrade={editTrade} />);
    const pairInput = screen.getByPlaceholderText(
      "BTC/USDT",
    ) as HTMLInputElement;
    expect(pairInput.value).toBe("BTC/USDT");
  });

  it("shows validation errors for empty required fields", () => {
    render(<TradeForm {...defaultProps} />);
    fireEvent.click(screen.getByText("Add Trade"));
    expect(screen.getByText("Pair is required")).toBeInTheDocument();
    expect(
      screen.getByText("Valid entry price is required"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Valid exit price is required"),
    ).toBeInTheDocument();
    expect(screen.getByText("Valid quantity is required")).toBeInTheDocument();
  });

  it("calls onClose when Cancel clicked", () => {
    render(<TradeForm {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when close button clicked", () => {
    render(<TradeForm {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    render(<TradeForm {...defaultProps} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls onClose when clicking overlay", () => {
    render(<TradeForm {...defaultProps} />);
    const overlay = document.querySelector(".modal-overlay");
    if (overlay) fireEvent.click(overlay);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it("does not close when clicking modal content", () => {
    render(<TradeForm {...defaultProps} />);
    const content = document.querySelector(".modal-content");
    if (content) fireEvent.click(content);
    // onClose should only be called once from overlay propagation prevention
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("shows direction select with long/short options", () => {
    render(<TradeForm {...defaultProps} />);
    const options = screen.getAllByRole("option");
    const optionTexts = options.map((o) => o.textContent);
    expect(optionTexts).toContain("Long");
    expect(optionTexts).toContain("Short");
  });

  it("shows PnL preview when valid inputs are entered", () => {
    render(<TradeForm {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("BTC/USDT"), {
      target: { value: "ETH/USDT" },
    });
    const priceInputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(priceInputs[0]!, { target: { value: "100" } }); // entry
    fireEvent.change(priceInputs[1]!, { target: { value: "110" } }); // exit
    fireEvent.change(priceInputs[2]!, { target: { value: "10" } }); // quantity

    expect(screen.getByText("Estimated PnL")).toBeInTheDocument();
  });

  it("renders emotion select options", () => {
    render(<TradeForm {...defaultProps} />);
    expect(screen.getByText("Select emotion...")).toBeInTheDocument();
    expect(screen.getByText("Confident")).toBeInTheDocument();
    expect(screen.getByText("FOMO")).toBeInTheDocument();
  });

  it("renders confidence buttons", () => {
    render(<TradeForm {...defaultProps} />);
    const buttons = screen.getAllByTitle(/Confidence: \d\/5/);
    expect(buttons).toHaveLength(5);
  });

  it("renders timeframe options", () => {
    render(<TradeForm {...defaultProps} />);
    expect(screen.getByText("Select timeframe...")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getByText("4h")).toBeInTheDocument();
  });

  it("submits valid trade data", () => {
    render(<TradeForm {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("BTC/USDT"), {
      target: { value: "ETH/USDT" },
    });
    const priceInputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(priceInputs[0]!, { target: { value: "100" } }); // entry
    fireEvent.change(priceInputs[1]!, { target: { value: "110" } }); // exit
    fireEvent.change(priceInputs[2]!, { target: { value: "10" } }); // quantity

    // Set dates
    const dateInputs = document.querySelectorAll(
      'input[type="datetime-local"]',
    );
    fireEvent.change(dateInputs[0]!, { target: { value: "2026-01-01T10:00" } });
    fireEvent.change(dateInputs[1]!, { target: { value: "2026-01-02T10:00" } });

    fireEvent.click(screen.getByText("Add Trade"));
    expect(mockOnSubmit).toHaveBeenCalledTimes(1);

    const submittedTrade = mockOnSubmit.mock.calls[0]![0];
    expect(submittedTrade.pair).toBe("ETH/USDT");
    expect(submittedTrade.entryPrice).toBe(100);
    expect(submittedTrade.exitPrice).toBe(110);
    expect(submittedTrade.pnl).toBe(100);
  });

  it("validates exit date must be after entry date", () => {
    render(<TradeForm {...defaultProps} />);

    fireEvent.change(screen.getByPlaceholderText("BTC/USDT"), {
      target: { value: "ETH/USDT" },
    });
    const priceInputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(priceInputs[0]!, { target: { value: "100" } });
    fireEvent.change(priceInputs[1]!, { target: { value: "110" } });
    fireEvent.change(priceInputs[2]!, { target: { value: "10" } });

    const dateInputs = document.querySelectorAll(
      'input[type="datetime-local"]',
    );
    fireEvent.change(dateInputs[0]!, { target: { value: "2026-01-02T10:00" } }); // entry after exit
    fireEvent.change(dateInputs[1]!, { target: { value: "2026-01-01T10:00" } });

    fireEvent.click(screen.getByText("Add Trade"));
    expect(
      screen.getByText("Exit date must be after entry date"),
    ).toBeInTheDocument();
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });
});
