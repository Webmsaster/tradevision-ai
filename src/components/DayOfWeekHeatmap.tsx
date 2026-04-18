"use client";

import { useMemo } from "react";
import { Trade } from "@/types/trade";

interface DayOfWeekHeatmapProps {
  trades: Trade[];
}

interface DayStat {
  label: string;
  shortLabel: string;
  count: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export default function DayOfWeekHeatmap({ trades }: DayOfWeekHeatmapProps) {
  const data = useMemo<DayStat[]>(() => {
    const buckets: Trade[][] = Array.from({ length: 7 }, () => []);
    for (const trade of trades) {
      const d = new Date(trade.exitDate).getDay();
      buckets[d].push(trade);
    }
    return buckets.map((bucket, i) => {
      const count = bucket.length;
      const totalPnl = bucket.reduce((s, t) => s + t.pnl, 0);
      const wins = bucket.filter((t) => t.pnl > 0).length;
      return {
        label: DAY_FULL[i],
        shortLabel: DAY_LABELS[i],
        count,
        totalPnl,
        avgPnl: count > 0 ? totalPnl / count : 0,
        winRate: count > 0 ? (wins / count) * 100 : 0,
      };
    });
  }, [trades]);

  const maxAbsAvg = Math.max(...data.map((d) => Math.abs(d.avgPnl)), 1);
  const hasAnyTrades = data.some((d) => d.count > 0);

  if (!hasAnyTrades) {
    return (
      <div className="weekly-summary">
        <h3 className="weekly-summary-title">Day of Week Performance</h3>
        <div className="weekly-empty">No trades to analyze yet</div>
      </div>
    );
  }

  return (
    <div className="weekly-summary">
      <h3 className="weekly-summary-title">Day of Week Performance</h3>
      <div className="weekly-summary-list">
        {data.map((day) => {
          const barWidth =
            day.count > 0 ? (Math.abs(day.avgPnl) / maxAbsAvg) * 100 : 0;
          const isProfit = day.avgPnl >= 0;
          const hasData = day.count > 0;
          const pnlFormatted = !hasData
            ? "—"
            : isProfit
              ? `+$${Math.abs(day.avgPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : `-$${Math.abs(day.avgPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          return (
            <div key={day.label}>
              <div className="weekly-row">
                <span className="weekly-label" title={day.label}>
                  {day.shortLabel}
                </span>
                <div className="weekly-bar-track">
                  {hasData && (
                    <div
                      className={`weekly-bar-fill ${isProfit ? "profit" : "loss"}`}
                      style={{ width: `${barWidth}%` }}
                    />
                  )}
                </div>
                <span
                  className="weekly-pnl"
                  style={{
                    color: !hasData
                      ? "var(--text-secondary)"
                      : isProfit
                        ? "var(--profit)"
                        : "var(--loss)",
                  }}
                >
                  {pnlFormatted}
                </span>
              </div>
              <div className="weekly-meta">
                {hasData
                  ? `${day.count} trade${day.count !== 1 ? "s" : ""} | ${day.winRate.toFixed(0)}% win rate | avg per trade`
                  : "No trades"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
