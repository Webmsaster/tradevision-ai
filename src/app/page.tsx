'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { calculateAllStats, calculateEquityCurve } from '@/utils/calculations';
import { generateAllInsights } from '@/utils/aiAnalysis';
import { useTradeStorage } from '@/hooks/useTradeStorage';
import StatCard from '@/components/StatCard';
import Skeleton from '@/components/Skeleton';
import TradeTable from '@/components/TradeTable';
import InsightCard from '@/components/InsightCard';
import WeeklySummary from '@/components/WeeklySummary';
import SyncErrorToast from '@/components/SyncErrorToast';
import { formatCurrency } from '@/utils/formatters';

interface DashboardWidgets {
  equityCurve: boolean;
  weeklySummary: boolean;
  recentTrades: boolean;
  aiInsights: boolean;
}

function loadWidgetSettings(): DashboardWidgets {
  const defaults: DashboardWidgets = { equityCurve: true, weeklySummary: true, recentTrades: true, aiInsights: true };
  try {
    const raw = localStorage.getItem('tradevision-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.widgets && typeof parsed.widgets === 'object') {
        return {
          equityCurve: typeof parsed.widgets.equityCurve === 'boolean' ? parsed.widgets.equityCurve : true,
          weeklySummary: typeof parsed.widgets.weeklySummary === 'boolean' ? parsed.widgets.weeklySummary : true,
          recentTrades: typeof parsed.widgets.recentTrades === 'boolean' ? parsed.widgets.recentTrades : true,
          aiInsights: typeof parsed.widgets.aiInsights === 'boolean' ? parsed.widgets.aiInsights : true,
        };
      }
    }
  } catch {}
  return defaults;
}

// Lazy load Recharts-based component – no SSR needed
const EquityCurve = dynamic(() => import('@/components/EquityCurve'), {
  ssr: false,
  loading: () => <Skeleton variant="card" />,
});

export default function DashboardPage() {
  const { trades, isLoading, setAllTrades, clearAll, syncError, dismissSyncError } = useTradeStorage();
  const [widgets, setWidgets] = useState<DashboardWidgets>({ equityCurve: true, weeklySummary: true, recentTrades: true, aiInsights: true });

  useEffect(() => {
    setWidgets(loadWidgetSettings());
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.widgets) setWidgets(detail.widgets);
    };
    window.addEventListener('tradevision-settings-changed', handler);
    return () => window.removeEventListener('tradevision-settings-changed', handler);
  }, []);

  // Detect demo mode by checking if sample data IDs are present
  const isDemoData = trades.length > 0 && trades[0]?.id?.startsWith('sample-');

  // Calculate stats from the current set of trades
  const stats = useMemo(() => calculateAllStats(trades), [trades]);

  // Build the equity curve data points
  const equityCurveData = useMemo(() => calculateEquityCurve(trades), [trades]);

  // Generate AI-driven insights sorted by severity (descending)
  const insights = useMemo(() => generateAllInsights(trades), [trades]);

  // Recent trades: last 10 sorted by exitDate descending
  const recentTrades = useMemo(() => {
    return [...trades]
      .sort(
        (a, b) =>
          new Date(b.exitDate).getTime() - new Date(a.exitDate).getTime()
      )
      .slice(0, 10);
  }, [trades]);

  // Top 3 insights by severity (already sorted from generateAllInsights)
  const topInsights = useMemo(() => insights.slice(0, 3), [insights]);

  /**
   * Load the built-in sample data set on demand, persist it, and switch to demo mode.
   * Uses dynamic import so the sample data bundle is only fetched when clicked.
   */
  const handleLoadSampleData = async () => {
    const { sampleTrades } = await import('@/data/sampleTrades');
    setAllTrades(sampleTrades);
  };

  /**
   * Clear demo data, remove from storage, and reset state.
   */
  const handleClearDemo = () => {
    clearAll();
  };

  // ------------------------------------------------------------------
  // Render: waiting for client-side hydration
  // ------------------------------------------------------------------
  if (isLoading) {
    return (
      <>
        <div className="dashboard-header">
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
        <div className="dashboard-kpi-grid">
          <Skeleton variant="card" count={4} />
        </div>
        <div className="dashboard-kpi-secondary">
          <Skeleton variant="card" count={3} />
        </div>
        <div className="dashboard-equity">
          <Skeleton variant="card" />
        </div>
      </>
    );
  }

  // ------------------------------------------------------------------
  // Render: empty state -- no trades at all
  // ------------------------------------------------------------------
  if (trades.length === 0) {
    return (
      <div className="dashboard-empty">
        <div className="dashboard-empty-icon">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.5, color: 'var(--text-secondary)' }}
          >
            <path d="M12 20V10" />
            <path d="M18 20V4" />
            <path d="M6 20v-4" />
          </svg>
        </div>
        <h2 className="dashboard-empty-title">No Trades Yet</h2>
        <p className="dashboard-empty-text">
          Start by importing your trading history or load our sample data set to
          explore the dashboard. Track your performance, identify patterns, and
          get AI-powered insights.
        </p>
        <div className="dashboard-empty-actions">
          <button className="btn btn-primary" onClick={handleLoadSampleData}>
            Load Sample Data
          </button>
          <Link href="/import" className="btn btn-secondary">
            Import Your Trades
          </Link>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render: populated dashboard
  // ------------------------------------------------------------------
  const pnlVariant: 'profit' | 'loss' =
    stats.totalPnl >= 0 ? 'profit' : 'loss';

  const winRateTrend: 'up' | 'down' | 'neutral' =
    stats.winRate >= 55 ? 'up' : stats.winRate >= 45 ? 'neutral' : 'down';

  const profitFactorDisplay =
    stats.profitFactor === Infinity ? 'Inf' : stats.profitFactor.toFixed(2);

  return (
    <>
      {/* Demo mode banner */}
      {isDemoData && (
        <div className="dashboard-banner">
          <span className="dashboard-banner-text">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            You are viewing sample data. Import your own trades for real
            insights.
          </span>
          <button className="dashboard-banner-btn" onClick={handleClearDemo}>
            Clear Demo Data
          </button>
        </div>
      )}

      {/* Page header */}
      <div className="dashboard-header">
        <h1 className="dashboard-title">Dashboard</h1>
        <p className="dashboard-subtitle">
          Your trading performance at a glance
        </p>
      </div>

      {/* Primary KPI row -- 4 columns */}
      <div className="dashboard-kpi-grid">
        <StatCard
          label="Total PnL"
          value={formatCurrency(stats.totalPnl)}
          variant={pnlVariant}
        />
        <StatCard
          label="Win Rate"
          value={`${stats.winRate.toFixed(1)}%`}
          trend={winRateTrend}
          trendValue={`${stats.longestWinStreak}W / ${stats.longestLossStreak}L streak`}
        />
        <StatCard
          label="Profit Factor"
          value={profitFactorDisplay}
          variant={stats.profitFactor >= 1.5 ? 'profit' : stats.profitFactor >= 1 ? 'default' : 'loss'}
        />
        <StatCard
          label="Expectancy"
          value={formatCurrency(stats.expectancy)}
          variant={stats.expectancy >= 0 ? 'profit' : 'loss'}
        />
      </div>

      {/* Secondary KPI row -- 3 columns */}
      <div className="dashboard-kpi-secondary">
        <StatCard
          label="Risk : Reward"
          value={stats.riskReward.toFixed(2)}
          suffix=":1"
        />
        <StatCard label="Total Trades" value={stats.totalTrades} />
        <StatCard
          label="Max Drawdown"
          value={formatCurrency(stats.maxDrawdown)}
          variant="loss"
          trendValue={`${stats.maxDrawdownPercent.toFixed(1)}% from peak`}
          trend="down"
        />
      </div>

      {/* Equity Curve -- full width */}
      {widgets.equityCurve && (
        <div className="dashboard-equity">
          <EquityCurve data={equityCurveData} />
        </div>
      )}

      {/* Weekly Performance Summary */}
      {widgets.weeklySummary && trades.length > 0 && (
        <div className="glass-card dashboard-weekly">
          <WeeklySummary trades={trades} />
        </div>
      )}

      {/* Bottom two-column layout: Recent Trades + AI Insights */}
      <div className="dashboard-bottom">
        {/* Left column -- Recent Trades */}
        {widgets.recentTrades && (
          <div className="glass-card dashboard-section">
            <div className="dashboard-section-header">
              <h2 className="dashboard-section-title">Recent Trades</h2>
              <Link href="/trades" className="dashboard-section-link">
                View All
              </Link>
            </div>
            <TradeTable trades={recentTrades} compact={true} />
          </div>
        )}

        {/* Right column -- AI Insights */}
        {widgets.aiInsights && (
          <div className="glass-card dashboard-section">
            <div className="dashboard-section-header">
              <h2 className="dashboard-section-title">AI Insights</h2>
              <Link href="/insights" className="dashboard-section-link">
                View All
              </Link>
            </div>

            {topInsights.length > 0 ? (
              <div className="dashboard-insights-list">
                {topInsights.map((insight) => (
                  <InsightCard key={insight.id} insight={insight} />
                ))}
              </div>
            ) : (
              <div className="dashboard-no-insights">
                <div className="dashboard-no-insights-icon">
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
                <p>
                  No actionable insights detected. Your trading looks solid --
                  keep it up!
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      <SyncErrorToast message={syncError} onDismiss={dismissSyncError} />
    </>
  );
}
