"use client";

import { useState, useEffect, useId } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { EquityCurvePoint } from "@/types/trade";
import { formatCurrency } from "@/utils/formatters";

interface EquityCurveProps {
  data: EquityCurvePoint[];
  height?: number;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}/${day}`;
}

interface TooltipPayloadEntry {
  dataKey: string;
  value: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  green: string;
  red: string;
}

function CustomTooltip({
  active,
  payload,
  label,
  green,
  red,
}: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const equityEntry = payload.find((p) => p.dataKey === "equity");
  const drawdownEntry = payload.find((p) => p.dataKey === "drawdown");

  const equityValue = equityEntry?.value as number | undefined;
  const drawdownValue = drawdownEntry?.value as number | undefined;

  return (
    <div className="equity-tooltip">
      <div className="equity-tooltip-date">{label}</div>
      {equityValue !== undefined && (
        <div
          className="equity-tooltip-value"
          style={{ color: equityValue >= 0 ? green : red }}
        >
          {formatCurrency(equityValue)}
        </div>
      )}
      {drawdownValue !== undefined && drawdownValue !== 0 && (
        <div className="equity-tooltip-drawdown">
          Drawdown: {formatCurrency(drawdownValue)}
        </div>
      )}
    </div>
  );
}

export default function EquityCurve({ data, height }: EquityCurveProps) {
  const [colors, setColors] = useState({ green: "#00ff88", red: "#ff4757" });
  useEffect(() => {
    function readColors() {
      const green = getComputedStyle(document.documentElement)
        .getPropertyValue("--profit")
        .trim();
      const red = getComputedStyle(document.documentElement)
        .getPropertyValue("--loss")
        .trim();
      if (green) setColors((c) => ({ ...c, green }));
      if (red) setColors((c) => ({ ...c, red }));
    }
    readColors();
    // Re-read colors when theme changes
    const observer = new MutationObserver(readColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Phase 33 (React Audit Bug 1): hooks MUST come before any early-return
  // (Rules of Hooks). Round 11's R48 fix was incomplete — useId() was still
  // after the if-empty check, breaking hook order when data flips between
  // empty/non-empty.
  const uniqueId = useId();
  const equityGradientId = `equityGradient-${uniqueId}`;
  const drawdownGradientId = `drawdownGradient-${uniqueId}`;

  if (!data || data.length === 0) {
    return (
      <div className="glass-card equity-curve">
        <h3 className="equity-curve-title">Equity Curve</h3>
        <div className="equity-curve-empty">No data available to display.</div>
      </div>
    );
  }

  const latestEquity = data[data.length - 1].equity;
  const lineColor = latestEquity >= 0 ? colors.green : colors.red;

  return (
    <div className="glass-card equity-curve">
      <h3 className="equity-curve-title">Equity Curve</h3>
      <div className="equity-curve-chart">
        <ResponsiveContainer width="100%" height={height || 350}>
          <AreaChart
            data={data}
            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
          >
            <defs>
              <linearGradient id={equityGradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
              </linearGradient>
              <linearGradient
                id={drawdownGradientId}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={colors.red} stopOpacity={0.15} />
                <stop offset="100%" stopColor={colors.red} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.05)"
            />
            <XAxis
              dataKey="date"
              tick={{ fill: "#64748b", fontSize: 12 }}
              tickFormatter={formatDate}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={{ stroke: "rgba(255,255,255,0.1)" }}
            />
            <YAxis
              tick={{ fill: "#64748b", fontSize: 12 }}
              tickFormatter={(value: number) => `$${value}`}
              axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
              tickLine={{ stroke: "rgba(255,255,255,0.1)" }}
            />
            <Tooltip
              content={<CustomTooltip green={colors.green} red={colors.red} />}
            />
            <Area
              type="monotone"
              dataKey="equity"
              stroke={lineColor}
              strokeWidth={2}
              fill={`url(#${equityGradientId})`}
              activeDot={{
                r: 5,
                stroke: lineColor,
                strokeWidth: 2,
                fill: "#0f1729",
              }}
            />
            <Area
              type="monotone"
              dataKey="drawdown"
              stroke={colors.red}
              strokeWidth={1}
              strokeOpacity={0.4}
              fill={`url(#${drawdownGradientId})`}
              activeDot={{
                r: 3,
                stroke: colors.red,
                strokeWidth: 1,
                fill: "#0f1729",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
