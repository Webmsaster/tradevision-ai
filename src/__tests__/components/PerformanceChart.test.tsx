import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import PerformanceChart from "@/components/PerformanceChart";
import { Trade, PerformanceByTime } from "@/types/trade";

// Mock recharts completely
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    BarChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="bar-chart">{children}</div>
    ),
    PieChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="pie-chart">{children}</div>
    ),
    Bar: () => null,
    Pie: () => null,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
  };
});

// Round 58 cleanup: deterministic counter ID (replaces Math.random()).
let _idCounter = 0;
beforeEach(() => {
  _idCounter = 0;
});

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: `t-${++_idCounter}`,
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

function makePerformanceByTime(
  overrides: Partial<PerformanceByTime> = {},
): PerformanceByTime {
  return {
    label: "Monday",
    trades: 1,
    winRate: 100,
    avgPnl: 10,
    totalPnl: 10,
    ...overrides,
  };
}

describe("PerformanceChart", () => {
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (prop: string) => {
        if (prop === "--profit") return "#00ff88";
        if (prop === "--loss") return "#ff4757";
        return "";
      },
    } as CSSStyleDeclaration);
  });

  describe("pnl-distribution", () => {
    it("renders empty-state message when no trades", () => {
      render(<PerformanceChart type="pnl-distribution" trades={[]} />);
      expect(screen.getByText("PnL Distribution")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders bar chart when trades provided", () => {
      const trades = [
        makeTrade({ pnl: 50 }),
        makeTrade({ pnl: -20 }),
        makeTrade({ pnl: 100 }),
      ];
      render(<PerformanceChart type="pnl-distribution" trades={trades} />);
      expect(screen.getByText("PnL Distribution")).toBeInTheDocument();
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });

    it("renders responsive container for distribution chart", () => {
      const trades = [makeTrade({ pnl: 50 })];
      render(<PerformanceChart type="pnl-distribution" trades={trades} />);
      expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
    });
  });

  describe("win-loss-pie", () => {
    it("renders empty-state message when no trades", () => {
      render(<PerformanceChart type="win-loss-pie" trades={[]} />);
      expect(screen.getByText("Win / Loss Ratio")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders pie chart when trades provided", () => {
      const trades = [
        makeTrade({ pnl: 50 }),
        makeTrade({ pnl: -20 }),
        makeTrade({ pnl: 100 }),
      ];
      render(<PerformanceChart type="win-loss-pie" trades={trades} />);
      expect(screen.getByText("Win / Loss Ratio")).toBeInTheDocument();
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });

    it("renders pie with only winning trades", () => {
      const trades = [makeTrade({ pnl: 50 }), makeTrade({ pnl: 100 })];
      render(<PerformanceChart type="win-loss-pie" trades={trades} />);
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });

    it("renders pie with only losing trades", () => {
      const trades = [makeTrade({ pnl: -20 }), makeTrade({ pnl: -50 })];
      render(<PerformanceChart type="win-loss-pie" trades={trades} />);
      expect(screen.getByTestId("pie-chart")).toBeInTheDocument();
    });
  });

  describe("by-day", () => {
    it("renders empty-state message when no data provided", () => {
      render(<PerformanceChart type="by-day" trades={[]} />);
      expect(screen.getByText("Performance by Day")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders empty-state message when data is empty array", () => {
      render(<PerformanceChart type="by-day" trades={[]} data={[]} />);
      expect(screen.getByText("Performance by Day")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders bar chart when time data provided", () => {
      const data = [
        makePerformanceByTime({ label: "Monday", totalPnl: 100 }),
        makePerformanceByTime({ label: "Tuesday", totalPnl: -50 }),
      ];
      render(<PerformanceChart type="by-day" trades={[]} data={data} />);
      expect(screen.getByText("Performance by Day")).toBeInTheDocument();
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  describe("by-hour", () => {
    it("renders empty-state message when no data provided", () => {
      render(<PerformanceChart type="by-hour" trades={[]} />);
      expect(screen.getByText("Performance by Hour")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders bar chart when time data provided", () => {
      const data = [
        makePerformanceByTime({ label: "08:00", totalPnl: 100 }),
        makePerformanceByTime({ label: "09:00", totalPnl: 200 }),
      ];
      render(<PerformanceChart type="by-hour" trades={[]} data={data} />);
      expect(screen.getByText("Performance by Hour")).toBeInTheDocument();
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  describe("by-pair", () => {
    it("renders empty-state message when no trades", () => {
      render(<PerformanceChart type="by-pair" trades={[]} />);
      expect(screen.getByText("Performance by Pair")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
    });

    it("renders bar chart when trades with pairs provided", () => {
      const trades = [
        makeTrade({ pair: "BTC/USDT", pnl: 100 }),
        makeTrade({ pair: "ETH/USDT", pnl: -50 }),
        makeTrade({ pair: "BTC/USDT", pnl: 50 }),
      ];
      render(<PerformanceChart type="by-pair" trades={trades} />);
      expect(screen.getByText("Performance by Pair")).toBeInTheDocument();
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });

    it("groups trades by pair and sums PnL", () => {
      const trades = [
        makeTrade({ pair: "BTC/USDT", pnl: 100 }),
        makeTrade({ pair: "BTC/USDT", pnl: 50 }),
        makeTrade({ pair: "ETH/USDT", pnl: 25 }),
      ];
      render(<PerformanceChart type="by-pair" trades={trades} />);
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  describe("custom height", () => {
    it("uses default height when not provided", () => {
      const trades = [makeTrade({ pnl: 50 })];
      render(<PerformanceChart type="pnl-distribution" trades={trades} />);
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });

    it("uses custom height when provided", () => {
      const trades = [makeTrade({ pnl: 50 })];
      render(
        <PerformanceChart
          type="pnl-distribution"
          trades={trades}
          height={500}
        />,
      );
      expect(screen.getByTestId("bar-chart")).toBeInTheDocument();
    });
  });

  describe("title rendering", () => {
    it("renders pnl-distribution title", () => {
      const trades = [makeTrade()];
      render(<PerformanceChart type="pnl-distribution" trades={trades} />);
      expect(screen.getByText("PnL Distribution")).toBeInTheDocument();
    });

    it("renders win-loss-pie title", () => {
      const trades = [makeTrade()];
      render(<PerformanceChart type="win-loss-pie" trades={trades} />);
      expect(screen.getByText("Win / Loss Ratio")).toBeInTheDocument();
    });

    it("renders by-day title", () => {
      const data = [makePerformanceByTime()];
      render(<PerformanceChart type="by-day" trades={[]} data={data} />);
      expect(screen.getByText("Performance by Day")).toBeInTheDocument();
    });

    it("renders by-hour title", () => {
      const data = [makePerformanceByTime()];
      render(<PerformanceChart type="by-hour" trades={[]} data={data} />);
      expect(screen.getByText("Performance by Hour")).toBeInTheDocument();
    });

    it("renders by-pair title", () => {
      const trades = [makeTrade()];
      render(<PerformanceChart type="by-pair" trades={trades} />);
      expect(screen.getByText("Performance by Pair")).toBeInTheDocument();
    });
  });
});
