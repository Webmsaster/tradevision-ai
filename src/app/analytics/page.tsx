'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  calculateAllStats,
  calculatePerformanceByDayOfWeek,
  calculatePerformanceByHour,
} from '@/utils/calculations';
import { Trade, TradeStats, PerformanceByTime } from '@/types/trade';
import { useTradeStorage } from '@/hooks/useTradeStorage';
import { formatFinite } from '@/utils/formatters';
import StatCard from '@/components/StatCard';
import Skeleton from '@/components/Skeleton';

// Lazy load Recharts-based component – no SSR needed
const PerformanceChart = dynamic(
  () => import('@/components/PerformanceChart'),
  {
    ssr: false,
    loading: () => <Skeleton variant="card" />,
  }
);

function formatHoldTime(ms: number): string {
  if (ms <= 0) return 'N/A';
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


export default function AnalyticsPage() {
  const { trades, isLoading: loading } = useTradeStorage();

  const stats = useMemo<TradeStats | null>(() => {
    if (trades.length === 0) return null;
    return calculateAllStats(trades) as TradeStats;
  }, [trades]);

  const performanceByDay = useMemo<PerformanceByTime[]>(() => {
    if (trades.length === 0) return [];
    return calculatePerformanceByDayOfWeek(trades) as PerformanceByTime[];
  }, [trades]);

  const performanceByHour = useMemo<PerformanceByTime[]>(() => {
    if (trades.length === 0) return [];
    return calculatePerformanceByHour(trades) as PerformanceByTime[];
  }, [trades]);

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
          <p className="page-subtitle">Deep dive into your trading performance</p>
        </div>
        <div className="empty-state">
          <h2>No Trades Found</h2>
          <p>Import your trades to see detailed analytics and performance charts.</p>
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
          value={stats ? `$${stats.avgWin.toFixed(2)}` : 'N/A'}
        />
        <StatCard
          label="Avg Loss"
          value={stats ? `$${stats.avgLoss.toFixed(2)}` : 'N/A'}
        />
      </div>

      <div className="analytics-stats-grid">
        <StatCard
          label="Risk:Reward Ratio"
          value={formatFinite(stats?.riskReward)}
        />
        <StatCard
          label="Longest Win Streak"
          value={stats?.longestWinStreak?.toString() ?? '0'}
        />
        <StatCard
          label="Longest Loss Streak"
          value={stats?.longestLossStreak?.toString() ?? '0'}
        />
        <StatCard
          label="Avg Hold Time"
          value={stats ? formatHoldTime(stats.avgHoldTime) : 'N/A'}
        />
      </div>

      {/* Section 2: Charts Section */}
      <div className="analytics-charts-grid">
        <PerformanceChart trades={trades} type="pnl-distribution" />
        <PerformanceChart trades={trades} type="win-loss-pie" />
      </div>

      {/* Section 3: Performance by Time */}
      <div className="analytics-charts-grid">
        <PerformanceChart trades={trades} type="by-day" data={performanceByDay} />
        <PerformanceChart trades={trades} type="by-hour" data={performanceByHour} />
      </div>

      {/* Section 4: Performance by Pair */}
      <div className="analytics-full-chart">
        <PerformanceChart trades={trades} type="by-pair" />
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
                <span>{new Date(stats.bestTrade.exitDate).toLocaleDateString()}</span>
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
                <span>{new Date(stats.worstTrade.exitDate).toLocaleDateString()}</span>
                <span>{stats.worstTrade.direction.toUpperCase()}</span>
              </div>
            </>
          ) : (
            <p>No data available</p>
          )}
        </div>
      </div>
    </div>
  );
}
