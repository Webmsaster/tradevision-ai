import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import InsightCard from "@/components/InsightCard";
import { AIInsight } from "@/types/trade";

function makeInsight(overrides: Partial<AIInsight> = {}): AIInsight {
  return {
    id: "test-1",
    type: "warning",
    title: "High loss streak detected",
    description: "You have had 4 losses in a row.",
    severity: 7,
    relatedTrades: ["t1", "t2"],
    category: "Risk",
    ...overrides,
  };
}

describe("InsightCard", () => {
  it("renders title, description, and category", () => {
    render(<InsightCard insight={makeInsight()} />);
    expect(screen.getByText("High loss streak detected")).toBeInTheDocument();
    expect(
      screen.getByText("You have had 4 losses in a row."),
    ).toBeInTheDocument();
    expect(screen.getByText("Risk")).toBeInTheDocument();
  });

  it("renders severity dots (10 total, N filled)", () => {
    const { container } = render(
      <InsightCard insight={makeInsight({ severity: 7 })} />,
    );
    const dots = container.querySelectorAll(".severity-dot");
    expect(dots.length).toBe(10);
    const filled = container.querySelectorAll(".severity-dot.filled");
    expect(filled.length).toBe(7);
  });

  it("renders warning type styling", () => {
    const { container } = render(
      <InsightCard insight={makeInsight({ type: "warning" })} />,
    );
    expect(
      container.querySelector(".insight-card.warning"),
    ).toBeInTheDocument();
  });

  it("renders positive type styling", () => {
    const { container } = render(
      <InsightCard insight={makeInsight({ type: "positive" })} />,
    );
    expect(
      container.querySelector(".insight-card.positive"),
    ).toBeInTheDocument();
  });

  it("renders neutral type styling", () => {
    const { container } = render(
      <InsightCard insight={makeInsight({ type: "neutral" })} />,
    );
    expect(
      container.querySelector(".insight-card.neutral"),
    ).toBeInTheDocument();
  });

  it("renders view trades button when callback and relatedTrades provided", () => {
    const onViewTrades = vi.fn();
    render(<InsightCard insight={makeInsight()} onViewTrades={onViewTrades} />);
    const btn = screen.getByText(/View 2 related trades/);
    expect(btn).toBeInTheDocument();
  });

  it('uses singular "trade" when only one related trade', () => {
    const onViewTrades = vi.fn();
    render(
      <InsightCard
        insight={makeInsight({ relatedTrades: ["t1"] })}
        onViewTrades={onViewTrades}
      />,
    );
    expect(screen.getByText("View 1 related trade")).toBeInTheDocument();
  });

  it("invokes onViewTrades with tradeIds when clicked", () => {
    const onViewTrades = vi.fn();
    render(<InsightCard insight={makeInsight()} onViewTrades={onViewTrades} />);
    fireEvent.click(screen.getByText(/View 2 related trades/));
    expect(onViewTrades).toHaveBeenCalledWith(["t1", "t2"]);
  });

  it("does not render view trades button when no callback", () => {
    render(<InsightCard insight={makeInsight()} />);
    expect(screen.queryByText(/related trade/)).not.toBeInTheDocument();
  });

  it("does not render view trades button when relatedTrades is empty", () => {
    const onViewTrades = vi.fn();
    render(
      <InsightCard
        insight={makeInsight({ relatedTrades: [] })}
        onViewTrades={onViewTrades}
      />,
    );
    expect(screen.queryByText(/related trade/)).not.toBeInTheDocument();
  });
});
