import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import StatCard from "@/components/StatCard";

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard label="Win Rate" value={65} />);
    expect(screen.getByText("Win Rate")).toBeInTheDocument();
    expect(screen.getByText("65")).toBeInTheDocument();
  });

  it("renders prefix and suffix around value", () => {
    render(<StatCard label="Total" value={1234} prefix="$" suffix="+" />);
    expect(screen.getByText("$1234+")).toBeInTheDocument();
  });

  it("applies profit variant class", () => {
    const { container } = render(
      <StatCard label="PnL" value={100} variant="profit" />,
    );
    expect(container.querySelector(".profit-glow")).toBeInTheDocument();
    expect(
      container.querySelector(".stat-card-value.profit"),
    ).toBeInTheDocument();
  });

  it("applies loss variant class", () => {
    const { container } = render(
      <StatCard label="PnL" value={-100} variant="loss" />,
    );
    expect(container.querySelector(".loss-glow")).toBeInTheDocument();
    expect(
      container.querySelector(".stat-card-value.loss"),
    ).toBeInTheDocument();
  });

  it("applies no variant class when default", () => {
    const { container } = render(<StatCard label="Trades" value={10} />);
    expect(container.querySelector(".profit-glow")).not.toBeInTheDocument();
    expect(container.querySelector(".loss-glow")).not.toBeInTheDocument();
  });

  it("renders trend indicator when trend and trendValue are provided", () => {
    const { container } = render(
      <StatCard label="PnL" value={100} trend="up" trendValue="+5%" />,
    );
    expect(screen.getByText("+5%")).toBeInTheDocument();
    expect(container.querySelector(".stat-card-trend.up")).toBeInTheDocument();
  });

  it("renders down trend", () => {
    const { container } = render(
      <StatCard label="PnL" value={100} trend="down" trendValue="-2%" />,
    );
    expect(
      container.querySelector(".stat-card-trend.down"),
    ).toBeInTheDocument();
  });

  it("renders neutral trend", () => {
    const { container } = render(
      <StatCard label="PnL" value={100} trend="neutral" trendValue="0%" />,
    );
    expect(
      container.querySelector(".stat-card-trend.neutral"),
    ).toBeInTheDocument();
  });

  it("does not render trend when trendValue is missing", () => {
    const { container } = render(
      <StatCard label="PnL" value={100} trend="up" />,
    );
    expect(container.querySelector(".stat-card-trend")).not.toBeInTheDocument();
  });

  it("renders custom icon when provided", () => {
    render(
      <StatCard
        label="PnL"
        value={100}
        icon={<span data-testid="custom-icon">x</span>}
      />,
    );
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });
});
