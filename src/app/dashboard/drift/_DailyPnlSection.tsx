"use client";

/**
 * Round 56 fix #6: extracted from page.tsx so the BarChart import is
 * dynamic — keeps the initial bundle of /dashboard/drift small.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface DailyPnlBar {
  date: string;
  pnlUsd: number;
  pnlPct: number;
  equityUsd: number;
}

function fmtPct(v: number, sign = true): string {
  const s = v.toFixed(2);
  return (sign && v >= 0 ? "+" : "") + s + "%";
}

function BarCell({ value }: { value: number }) {
  return <Cell fill={value >= 0 ? "#10b981" : "#ef4444"} />;
}

export function DailyPnlSection({ bars }: { bars: DailyPnlBar[] }) {
  return (
    <section className="bg-surface rounded-xl p-5">
      <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide mb-3">
        Daily P&amp;L (last {bars.length} days)
      </h2>
      {bars.length === 0 ? (
        <div className="text-txt/60 text-sm py-8 text-center">
          No daily anchors yet — bot has not written any{" "}
          <code>daily-reset</code> events.
        </div>
      ) : (
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={bars}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#94a3b8", fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f1623",
                  border: "1px solid #2a2f3a",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v) => [
                  typeof v === "number" ? fmtPct(v) : String(v ?? "—"),
                  "P&L",
                ]}
              />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <ReferenceLine y={-5} stroke="#ef4444" strokeDasharray="2 2" />
              <Bar dataKey="pnlPct" name="P&L" isAnimationActive={false}>
                {bars.map((b, i) => (
                  <BarCell key={i} value={b.pnlPct} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
