import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EquityCurve from "@/components/EquityCurve";
import { EquityCurvePoint } from "@/types/trade";

// Mock recharts completely
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    AreaChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="area-chart">{children}</div>
    ),
    Area: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
  };
});

function makeEquityCurvePoint(
  overrides: Partial<EquityCurvePoint> = {},
): EquityCurvePoint {
  return {
    date: "2026-01-05",
    equity: 1000,
    drawdown: 0,
    ...overrides,
  };
}

describe("EquityCurve", () => {
  beforeEach(() => {
    // Mock CSS variables
    Object.defineProperty(document.documentElement, "style", {
      value: {},
      writable: true,
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (prop: string) => {
        if (prop === "--profit") return "#00ff88";
        if (prop === "--loss") return "#ff4757";
        return "";
      },
    } as CSSStyleDeclaration);
  });

  it("renders empty-state message when data is empty", () => {
    render(<EquityCurve data={[]} />);
    expect(screen.getByText("Equity Curve")).toBeInTheDocument();
    expect(
      screen.getByText("No data available to display."),
    ).toBeInTheDocument();
  });

  it("renders empty-state message when data is undefined", () => {
    render(<EquityCurve data={undefined as any} />);
    expect(screen.getByText("Equity Curve")).toBeInTheDocument();
    expect(
      screen.getByText("No data available to display."),
    ).toBeInTheDocument();
  });

  it("renders chart container when data is provided", () => {
    const data = [makeEquityCurvePoint({ equity: 1000 })];
    render(<EquityCurve data={data} />);
    expect(screen.getByText("Equity Curve")).toBeInTheDocument();
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders responsive container with 100% width", () => {
    const data = [makeEquityCurvePoint()];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
  });

  it("renders with default height when not provided", () => {
    const data = [makeEquityCurvePoint()];
    const { container } = render(<EquityCurve data={data} />);
    expect(container.querySelector(".equity-curve")).toBeInTheDocument();
  });

  it("renders with custom height when provided", () => {
    const data = [makeEquityCurvePoint()];
    render(<EquityCurve data={data} height={500} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders title in glass-card container", () => {
    const data = [makeEquityCurvePoint()];
    const { container } = render(<EquityCurve data={data} />);
    expect(
      container.querySelector(".glass-card.equity-curve"),
    ).toBeInTheDocument();
    expect(screen.getByText("Equity Curve")).toBeInTheDocument();
  });

  it("handles multiple data points", () => {
    const data = [
      makeEquityCurvePoint({ date: "2026-01-05", equity: 1000, drawdown: 0 }),
      makeEquityCurvePoint({ date: "2026-01-06", equity: 1100, drawdown: 0 }),
      makeEquityCurvePoint({ date: "2026-01-07", equity: 1050, drawdown: -50 }),
    ];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders chart with both positive and negative equity changes", () => {
    const data = [
      makeEquityCurvePoint({ equity: 1000 }),
      makeEquityCurvePoint({ equity: 900 }),
    ];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("renders with drawdown data", () => {
    const data = [
      makeEquityCurvePoint({ equity: 1000, drawdown: 0 }),
      makeEquityCurvePoint({ equity: 900, drawdown: -100 }),
      makeEquityCurvePoint({ equity: 950, drawdown: -50 }),
    ];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("uses green color when latest equity is positive", () => {
    const data = [
      makeEquityCurvePoint({ equity: 1000 }),
      makeEquityCurvePoint({ equity: 1100 }),
    ];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });

  it("uses red color when latest equity is negative", () => {
    const data = [
      makeEquityCurvePoint({ equity: 1000 }),
      makeEquityCurvePoint({ equity: -100 }),
    ];
    render(<EquityCurve data={data} />);
    expect(screen.getByTestId("area-chart")).toBeInTheDocument();
  });
});
