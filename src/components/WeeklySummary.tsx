"use client";
import { useMemo } from "react";
import { Trade } from "@/types/trade";

interface WeeklySummaryProps {
  trades: Trade[];
}

interface WeekData {
  year: number;
  week: number;
  label: string;
  tradeCount: number;
  totalPnl: number;
  winRate: number;
  isCurrent: boolean;
}

// Round 56 fix #3: every date operation here is UTC. Mixing local-getter
// (e.g. getMonth) with UTC-constructor (Date.UTC) shifted weeks by 1 in
// the southern hemisphere on Saturday/Sunday boundaries.
function getWeekNumber(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function getWeekStart(date: Date): Date {
  // ISO-week starts on Monday (UTC).
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d;
}

function formatWeekLabel(weekStart: Date): string {
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  // toLocaleString with timeZone:'UTC' so we read the same UTC fields the
  // rest of this module operates on — no surprise "Apr/Mar" flips at
  // midnight-UTC.
  const startMonth = weekStart.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const endMonth = weekEnd.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });

  const startDay = weekStart.getUTCDate();
  const endDay = weekEnd.getUTCDate();

  if (startMonth === endMonth) {
    return `${startMonth} ${startDay} - ${endDay}`;
  }
  return `${startMonth} ${startDay} - ${endMonth} ${endDay}`;
}

export default function WeeklySummary({ trades }: WeeklySummaryProps) {
  const weeklyData = useMemo(() => {
    if (trades.length === 0) return [];

    const now = new Date();
    const currentWeek = getWeekNumber(now);
    const currentYear = now.getUTCFullYear();

    // Group trades by year-week key using exitDate (UTC throughout).
    const weekMap = new Map<
      string,
      { trades: Trade[]; weekStart: Date; year: number; week: number }
    >();

    trades.forEach((trade) => {
      const exitDate = new Date(trade.exitDate);
      const week = getWeekNumber(exitDate);
      const year = exitDate.getUTCFullYear();
      const key = `${year}-${week}`;
      const weekStart = getWeekStart(exitDate);

      if (!weekMap.has(key)) {
        weekMap.set(key, { trades: [], weekStart, year, week });
      }
      weekMap.get(key)!.trades.push(trade);
    });

    // Convert to WeekData array
    const weeks: WeekData[] = Array.from(weekMap.entries()).map(([, data]) => {
      const tradeCount = data.trades.length;
      const totalPnl = data.trades.reduce((sum, t) => sum + t.pnl, 0);
      const wins = data.trades.filter((t) => t.pnl > 0).length;
      const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
      const isCurrent = data.year === currentYear && data.week === currentWeek;
      const label = formatWeekLabel(data.weekStart);

      return {
        year: data.year,
        week: data.week,
        label,
        tradeCount,
        totalPnl,
        winRate,
        isCurrent,
      };
    });

    // Sort by year then week descending, take last 8
    weeks.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.week - a.week;
    });

    return weeks.slice(0, 8).reverse();
  }, [trades]);

  if (weeklyData.length < 2) {
    return (
      <div className="weekly-summary">
        <h3 className="weekly-summary-title">Weekly Performance</h3>
        <div className="weekly-empty">Need more data for weekly comparison</div>
      </div>
    );
  }

  const maxAbsPnl = Math.max(...weeklyData.map((w) => Math.abs(w.totalPnl)), 1);

  return (
    <div className="weekly-summary">
      <h3 className="weekly-summary-title">Weekly Performance</h3>
      <div className="weekly-summary-list">
        {weeklyData.map((week) => {
          const barWidth = (Math.abs(week.totalPnl) / maxAbsPnl) * 100;
          const isProfit = week.totalPnl >= 0;
          const pnlFormatted = isProfit
            ? `+$${Math.abs(week.totalPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `-$${Math.abs(week.totalPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          return (
            <div key={`${week.year}-${week.week}`}>
              <div className={`weekly-row${week.isCurrent ? " current" : ""}`}>
                <span className="weekly-label">{week.label}</span>
                <div className="weekly-bar-track">
                  <div
                    className={`weekly-bar-fill ${isProfit ? "profit" : "loss"}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
                <span
                  className="weekly-pnl"
                  style={{ color: isProfit ? "var(--profit)" : "var(--loss)" }}
                >
                  {pnlFormatted}
                </span>
              </div>
              <div className="weekly-meta">
                {week.tradeCount} trade{week.tradeCount !== 1 ? "s" : ""} |{" "}
                {week.winRate.toFixed(0)}% win rate
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
