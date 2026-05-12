"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  calculateAllStats,
  calculatePerformanceByDayOfWeek,
  calculatePerformanceByHour,
} from "@/utils/calculations";
import { TradeStats, PerformanceByTime } from "@/types/trade";
import { useTradeStorage } from "@/hooks/useTradeStorage";
import { formatFinite, formatShortDate } from "@/utils/formatters";
import StatCard from "@/components/StatCard";
import Skeleton from "@/components/Skeleton";

// Lazy load Recharts-based component - no SSR needed
const PerformanceChart = dynamic(
  () => import("@/components/PerformanceChart"),
  {
    ssr: false,
    loading: () => <Skeleton variant="card" />,
  },
);

function formatHoldTime(ms: number): string {
  if (ms <= 0) return "N/A";
  const minutes = ms / (1000 * 60);
  const hours = ms / (1000 * 60 * 60);
  const days = ms / (1000 * 60 * 60 * 24);

  if (hours < 1) {
    return `${Math.round(minutes)} min`;
  } else if (hours < 24) {
    return `${hours.toFixed(1)} hrs`;
  } else {
    return `${days.toFixed(1)} days`;
  }
}

// R67-Final: useSearchParams() forces client-side bailout — Next requires
// it under a Suspense boundary so the static skeleton can pre-render.
export default function AnalyticsPage() {
  return (
    <Suspense
      fallback={
        <div className="page-container">
          <div className="page-header">
            <div>
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </div>
          </div>
          <div className="analytics-stats-grid">
            <Skeleton variant="card" count={4} />
          </div>
        </div>
      }
    >
      <AnalyticsPageInner />
    </Suspense>
  );
}

function AnalyticsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { trades, isLoading: loading } = useTradeStorage();

  // R67-Final: URL-param persistence so reload preserves date filter.
  const [dateFrom, setDateFrom] = useState<string>(
    () => searchParams.get("dateFrom") ?? "",
  );
  const [dateTo, setDateTo] = useState<string>(
    () => searchParams.get("dateTo") ?? "",
  );

  // R67-RR6-Round2 audit fix: one-way URL → state sync for in-place URL
  // changes (shared link clicks while the component stays mounted).
  // Without this, an external URL change to ?dateFrom=... would be
  // overwritten by the state→URL effect below using the now-stale state.
  const urlDateFrom = searchParams.get("dateFrom") ?? "";
  const urlDateTo = searchParams.get("dateTo") ?? "";
  useEffect(() => {
    if (urlDateFrom !== dateFrom) setDateFrom(urlDateFrom);
    if (urlDateTo !== dateTo) setDateTo(urlDateTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDateFrom, urlDateTo]);

  // Push filter state back into URL — keep behaviour-equivalent when no
  // filters are set (no params land in the URL bar).
  useEffect(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    const qs = params.toString();
    const next = qs ? `/analytics?${qs}` : "/analytics";
    // Avoid pushing duplicate URL state on every keystroke that yields
    // the same string.
    const current =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "";
    if (current !== next) {
      router.replace(next, { scroll: false });
    }
  }, [dateFrom, dateTo, router]);

  // R67-Final: same UTC-pinned boundary logic as insights/page.tsx
  // (see R67-r21 fix). Bare YYYY-MM-DD parsed via Date.parse(...+"T...Z")
  // pins the cut-off to UTC instead of local TZ. Invalid input strings
  // are skipped so the user sees ALL trades, not a silent empty list.
  const filteredTrades = useMemo(() => {
    if (!dateFrom && !dateTo) return trades;
    const fromMs = dateFrom ? Date.parse(dateFrom + "T00:00:00.000Z") : NaN;
    const toMs = dateTo ? Date.parse(dateTo + "T23:59:59.999Z") : NaN;
    return trades.filter((trade) => {
      const entryMs = Date.parse(trade.entryDate);
      if (!Number.isFinite(entryMs)) return false;
      if (Number.isFinite(fromMs) && entryMs < fromMs) return false;
      if (Number.isFinite(toMs) && entryMs > toMs) return false;
      return true;
    });
  }, [trades, dateFrom, dateTo]);

  const stats = useMemo<TradeStats | null>(() => {
    if (filteredTrades.length === 0) return null;
    return calculateAllStats(filteredTrades) as TradeStats;
  }, [filteredTrades]);

  const performanceByDay = useMemo<PerformanceByTime[]>(() => {
    if (filteredTrades.length === 0) return [];
    return calculatePerformanceByDayOfWeek(
      filteredTrades,
    ) as PerformanceByTime[];
  }, [filteredTrades]);

  const performanceByHour = useMemo<PerformanceByTime[]>(() => {
    if (filteredTrades.length === 0) return [];
    return calculatePerformanceByHour(filteredTrades) as PerformanceByTime[];
  }, [filteredTrades]);

  const clearFilters = useCallback(() => {
    setDateFrom("");
    setDateTo("");
  }, []);

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <div>
            <Skeleton variant="text" />
            <Skeleton variant="text" />
          </div>
        </div>
        <div className="analytics-stats-grid">
          <Skeleton variant="card" count={4} />
        </div>
        <div className="analytics-stats-grid">
          <Skeleton variant="card" count={4} />
        </div>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Analytics</h1>
          <p className="page-subtitle">
            Deep dive into your trading performance
          </p>
        </div>
        <div className="empty-state">
          <h2>No Trades Found</h2>
          <p>
            Import your trades to see detailed analytics and performance charts.
          </p>
          <Link href="/import" className="btn btn-primary">
            Go to Import
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Analytics</h1>
        <p className="page-subtitle">Deep dive into your trading performance</p>
      </div>

      {/* R67-Final: date-range filter mirrors insights page */}
      <div className="insights-filters">
        <div className="insights-filters-group">
          <label className="insights-filter-label" htmlFor="analytics-from">
            From
          </label>
          <input
            id="analytics-from"
            type="date"
            className="input insights-date-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="insights-filters-group">
          <label className="insights-filter-label" htmlFor="analytics-to">
            To
          </label>
          <input
            id="analytics-to"
            type="date"
            className="input insights-date-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {(dateFrom || dateTo) && (
          <button className="insights-filters-clear" onClick={clearFilters}>
            Clear Filters
          </button>
        )}
      </div>

      {filteredTrades.length === 0 ? (
        <div className="empty-state">
          <h2>No trades in this range</h2>
          <p>Adjust the date filter to see analytics.</p>
        </div>
      ) : (
        <>
          {/* Section 1: Detailed Stats Grid */}
          <div className="analytics-stats-grid">
            <StatCard
              label="Sharpe Ratio"
              value={formatFinite(stats?.sharpeRatio)}
            />
            <StatCard
              label="Profit Factor"
              value={formatFinite(stats?.profitFactor)}
            />
            <StatCard
              label="Avg Win"
              value={stats ? `$${stats.avgWin.toFixed(2)}` : "N/A"}
            />
            <StatCard
              label="Avg Loss"
              value={stats ? `$${stats.avgLoss.toFixed(2)}` : "N/A"}
            />
          </div>

          <div className="analytics-stats-grid">
            <StatCard
              label="Risk:Reward Ratio"
              value={formatFinite(stats?.riskReward)}
            />
            <StatCard
              label="Longest Win Streak"
              value={stats?.longestWinStreak?.toString() ?? "0"}
            />
            <StatCard
              label="Longest Loss Streak"
              value={stats?.longestLossStreak?.toString() ?? "0"}
            />
            <StatCard
              label="Avg Hold Time"
              value={stats ? formatHoldTime(stats.avgHoldTime) : "N/A"}
            />
          </div>

          {/* Section 2: Charts Section */}
          <div className="analytics-charts-grid">
            <PerformanceChart trades={filteredTrades} type="pnl-distribution" />
            <PerformanceChart trades={filteredTrades} type="win-loss-pie" />
          </div>

          {/* Section 3: Performance by Time */}
          <div className="analytics-charts-grid">
            <PerformanceChart
              trades={filteredTrades}
              type="by-day"
              data={performanceByDay}
            />
            <PerformanceChart
              trades={filteredTrades}
              type="by-hour"
              data={performanceByHour}
            />
          </div>

          {/* Section 4: Performance by Pair */}
          <div className="analytics-full-chart">
            <PerformanceChart trades={filteredTrades} type="by-pair" />
          </div>

          {/* Section 5: Best & Worst Trades */}
          <div className="analytics-highlights">
            <div className="card analytics-highlight-card">
              <div className="analytics-highlight-label">Best Trade</div>
              {stats?.bestTrade ? (
                <>
                  <div className="analytics-highlight-pair">
                    {stats.bestTrade.pair}
                  </div>
                  <div className="analytics-highlight-pnl text-profit">
                    +${stats.bestTrade.pnl.toFixed(2)}
                  </div>
                  <div className="analytics-highlight-meta">
                    <span>
                      {formatShortDate(stats.bestTrade.exitDate, {
                        displayInUTC: true,
                      })}
                    </span>
                    <span>{stats.bestTrade.direction.toUpperCase()}</span>
                  </div>
                </>
              ) : (
                <p>No data available</p>
              )}
            </div>

            <div className="card analytics-highlight-card">
              <div className="analytics-highlight-label">Worst Trade</div>
              {stats?.worstTrade ? (
                <>
                  <div className="analytics-highlight-pair">
                    {stats.worstTrade.pair}
                  </div>
                  <div className="analytics-highlight-pnl text-loss">
                    ${stats.worstTrade.pnl.toFixed(2)}
                  </div>
                  <div className="analytics-highlight-meta">
                    <span>
                      {formatShortDate(stats.worstTrade.exitDate, {
                        displayInUTC: true,
                      })}
                    </span>
                    <span>{stats.worstTrade.direction.toUpperCase()}</span>
                  </div>
                </>
              ) : (
                <p>No data available</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
