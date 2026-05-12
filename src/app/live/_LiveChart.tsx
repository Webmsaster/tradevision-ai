"use client";

/**
 * R-Perf: extracted from page.tsx so the heavy recharts surface
 * (~120KB minified) is loaded lazily via `next/dynamic` only after the
 * live-signals frame is interactive.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ChartPoint {
  time: string;
  price: number;
  buy: number | null;
  sell: number | null;
}

interface LiveChartProps {
  chartData: ChartPoint[];
  supports?: number[];
  resistances?: number[];
  vwapNow?: number | null;
}

export function LiveChart({
  chartData,
  supports = [],
  resistances = [],
  vwapNow = null,
}: LiveChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="price-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f8cff" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#4f8cff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
          minTickGap={40}
        />
        <YAxis
          domain={["dataMin", "dataMax"]}
          tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
          width={70}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface-elevated, #1c1f26)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Area
          type="monotone"
          dataKey="price"
          stroke="#4f8cff"
          strokeWidth={2}
          fill="url(#price-area)"
        />
        <Area
          type="monotone"
          dataKey="buy"
          stroke="#00ff88"
          fill="transparent"
          dot={{ r: 6, fill: "#00ff88", stroke: "#00ff88" }}
          activeDot={false}
        />
        <Area
          type="monotone"
          dataKey="sell"
          stroke="#ff4757"
          fill="transparent"
          dot={{ r: 6, fill: "#ff4757", stroke: "#ff4757" }}
          activeDot={false}
        />
        {supports.map((s) => (
          <ReferenceLine
            key={`sup-${s}`}
            y={s}
            stroke="rgba(0,255,136,0.35)"
            strokeDasharray="4 4"
            label={{
              value: `S ${s.toFixed(0)}`,
              position: "right",
              fill: "#00ff88",
              fontSize: 10,
            }}
          />
        ))}
        {resistances.map((r) => (
          <ReferenceLine
            key={`res-${r}`}
            y={r}
            stroke="rgba(255,71,87,0.35)"
            strokeDasharray="4 4"
            label={{
              value: `R ${r.toFixed(0)}`,
              position: "right",
              fill: "#ff4757",
              fontSize: 10,
            }}
          />
        ))}
        {vwapNow && (
          <ReferenceLine
            y={vwapNow}
            stroke="rgba(139, 92, 246, 0.5)"
            strokeDasharray="2 6"
            label={{
              value: `VWAP`,
              position: "left",
              fill: "#a78bfa",
              fontSize: 10,
            }}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
