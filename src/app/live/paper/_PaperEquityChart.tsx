"use client";

/**
 * R-Perf: extracted from page.tsx so the heavy recharts surface
 * (~120KB minified) is loaded lazily via `next/dynamic` only after the
 * paper-log page becomes interactive.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface CurvePoint {
  idx: number;
  time: string;
  equity: number;
  cumReturnPct: number;
}

export function PaperEquityChart({ data }: { data: CurvePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="idx"
          tick={{ fontSize: 10 }}
          label={{
            value: "Trade #",
            position: "insideBottom",
            offset: -5,
            fontSize: 10,
          }}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          domain={["auto", "auto"]}
          tickFormatter={(v) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={{
            background: "#222",
            border: "1px solid #333",
          }}
          formatter={(v) => {
            const n = typeof v === "number" ? v : Number(v);
            return `$${n.toFixed(2)}`;
          }}
        />
        <Area
          type="monotone"
          dataKey="equity"
          stroke="#22c55e"
          fill="url(#eqGrad)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
