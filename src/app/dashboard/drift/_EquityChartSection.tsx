"use client";

/**
 * Round 56 fix #6: extracted from page.tsx so the heavy recharts surface
 * (~120KB minified) is loaded lazily via `next/dynamic` only after the
 * dashboard frame is interactive.
 */
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface BacktestPoint {
  day: number;
  median: number;
  p10: number;
  p90: number;
}
interface EquityPoint {
  ts: string;
  day: number;
  equityUsd: number;
  equityPct: number;
}
interface NewsMarker {
  ts: string;
  label: string;
}
interface EquityCurveData {
  equityHistory: EquityPoint[];
  backtestBand: BacktestPoint[];
  newsMarkers: NewsMarker[];
  meta: { backtestRef: { maxChallengeDays: number } };
  equity: { targetPct: number; tlCapPct: number; dlCapPct: number };
}

function fmtPct(v: number, sign = true): string {
  const s = v.toFixed(2);
  return (sign && v >= 0 ? "+" : "") + s + "%";
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block w-3 h-3 rounded-sm"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

export function EquityChartSection({ data }: { data: EquityCurveData }) {
  const merged = useMemo(() => {
    const liveByDay = new Map<number, number>();
    for (const p of data.equityHistory) {
      liveByDay.set(p.day, p.equityPct);
    }
    return data.backtestBand.map((b) => ({
      day: b.day,
      median: b.median,
      p10: b.p10,
      p90: b.p90,
      band: [b.p10, b.p90] as [number, number],
      live: liveByDay.has(b.day) ? liveByDay.get(b.day) : undefined,
    }));
  }, [data.backtestBand, data.equityHistory]);

  const newsByDay = useMemo(() => {
    if (data.equityHistory.length === 0) return [];
    const firstTs = new Date(data.equityHistory[0]!.ts).getTime();
    if (!Number.isFinite(firstTs)) return [];
    return data.newsMarkers
      .map((m) => {
        const t = new Date(m.ts).getTime();
        if (!Number.isFinite(t)) return null;
        const day = Math.floor((t - firstTs) / (24 * 3600 * 1000));
        if (day < 0 || day > data.meta.backtestRef.maxChallengeDays)
          return null;
        return { day, label: m.label };
      })
      .filter((x): x is { day: number; label: string } => x !== null);
  }, [
    data.newsMarkers,
    data.equityHistory,
    data.meta.backtestRef.maxChallengeDays,
  ]);

  return (
    <section className="bg-surface rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide">
          Equity curve — live vs backtest band
        </h2>
        <div className="text-xs text-txt/60 flex items-center gap-3 flex-wrap">
          <LegendDot color="rgba(96, 165, 250, 0.25)" label="p10–p90 band" />
          <LegendDot color="#60a5fa" label="median" />
          <LegendDot color="#10b981" label="live" />
          <LegendDot color="#ef4444" label="DL/TL caps" />
        </div>
      </div>
      {merged.length === 0 ? (
        <div className="h-[320px] flex items-center justify-center text-txt/60 text-sm">
          No backtest band loaded — check FTMO_TF slug
        </div>
      ) : (
        <div className="h-[320px] sm:h-[400px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={merged}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
              <XAxis
                dataKey="day"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                label={{
                  value: "Challenge day",
                  position: "insideBottom",
                  offset: -2,
                  fill: "#94a3b8",
                  fontSize: 11,
                }}
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
                domain={["dataMin - 2", "dataMax + 2"]}
              />
              <Tooltip
                contentStyle={{
                  background: "#0f1623",
                  border: "1px solid #2a2f3a",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#e6edf3" }}
                formatter={(v, name) => {
                  if (typeof v === "number") {
                    return [fmtPct(v), String(name)];
                  }
                  if (Array.isArray(v) && v.length === 2) {
                    const lo = Number(v[0]);
                    const hi = Number(v[1]);
                    if (Number.isFinite(lo) && Number.isFinite(hi)) {
                      return [`${fmtPct(lo)} … ${fmtPct(hi)}`, String(name)];
                    }
                  }
                  return [String(v ?? "—"), String(name)];
                }}
                labelFormatter={(label) => `Day ${label}`}
              />
              <Area
                type="monotone"
                dataKey="band"
                stroke="none"
                fill="#60a5fa"
                fillOpacity={0.18}
                isAnimationActive={false}
                name="band"
              />
              <Line
                type="monotone"
                dataKey="median"
                stroke="#60a5fa"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
                name="median"
              />
              <Line
                type="monotone"
                dataKey="live"
                stroke="#10b981"
                strokeWidth={2.5}
                dot={{ r: 3, fill: "#10b981" }}
                connectNulls
                isAnimationActive={false}
                name="live"
              />
              <ReferenceLine
                y={data.equity.targetPct}
                stroke="#10b981"
                strokeDasharray="2 2"
                label={{
                  value: `+${data.equity.targetPct}% target`,
                  fill: "#10b981",
                  fontSize: 10,
                  position: "right",
                }}
              />
              <ReferenceLine
                y={data.equity.tlCapPct}
                stroke="#ef4444"
                strokeDasharray="2 2"
                label={{
                  value: "-10% TL",
                  fill: "#ef4444",
                  fontSize: 10,
                  position: "right",
                }}
              />
              <ReferenceLine
                y={data.equity.dlCapPct}
                stroke="#f59e0b"
                strokeDasharray="2 2"
                label={{
                  value: "-5% DL",
                  fill: "#f59e0b",
                  fontSize: 10,
                  position: "right",
                }}
              />
              {newsByDay.map((m, i) => (
                <ReferenceLine
                  key={`${m.day}-${i}`}
                  x={m.day}
                  stroke="#a78bfa"
                  strokeDasharray="2 4"
                  label={{
                    value: m.label,
                    fill: "#a78bfa",
                    fontSize: 9,
                    position: "top",
                  }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
