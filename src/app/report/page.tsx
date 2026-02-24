'use client';

import { useMemo } from 'react';
import { calculateAllStats, calculatePerformanceByDayOfWeek } from '@/utils/calculations';
import { TradeStats, PerformanceByTime } from '@/types/trade';
import { useTradeStorage } from '@/hooks/useTradeStorage';
import { formatCurrency, formatFinite } from '@/utils/formatters';

export default function ReportPage() {
  const { trades, isLoading } = useTradeStorage();

  const stats = useMemo<TradeStats | null>(() => {
    if (trades.length === 0) return null;
    return calculateAllStats(trades) as TradeStats;
  }, [trades]);

  const byDay = useMemo<PerformanceByTime[]>(() => {
    if (trades.length === 0) return [];
    return calculatePerformanceByDayOfWeek(trades) as PerformanceByTime[];
  }, [trades]);

  const topPairs = useMemo(() => {
    const map: Record<string, { pnl: number; trades: number; wins: number }> = {};
    for (const t of trades) {
      if (!map[t.pair]) map[t.pair] = { pnl: 0, trades: 0, wins: 0 };
      map[t.pair].pnl += t.pnl;
      map[t.pair].trades += 1;
      if (t.pnl > 0) map[t.pair].wins += 1;
    }
    return Object.entries(map)
      .map(([pair, d]) => ({ pair, ...d, winRate: (d.wins / d.trades) * 100 }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [trades]);

  if (isLoading) return <div className="report-page"><p>Loading...</p></div>;

  if (!stats) {
    return (
      <div className="report-page">
        <h1>Performance Report</h1>
        <p>No trades available. Import trades to generate a report.</p>
      </div>
    );
  }

  const reportDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return (
    <div className="report-page">
      <div className="report-header">
        <h1>TradeVision AI - Performance Report</h1>
        <p className="report-date">Generated on {reportDate}</p>
        <button className="btn btn-primary report-print-btn" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>

      <section className="report-section">
        <h2>Overview</h2>
        <div className="report-grid">
          <div className="report-stat">
            <span className="report-stat-label">Total Trades</span>
            <span className="report-stat-value">{stats.totalTrades}</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Total PnL</span>
            <span className={`report-stat-value ${stats.totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {formatCurrency(stats.totalPnl)}
            </span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Win Rate</span>
            <span className="report-stat-value">{stats.winRate.toFixed(1)}%</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Profit Factor</span>
            <span className="report-stat-value">{formatFinite(stats.profitFactor)}</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Sharpe Ratio</span>
            <span className="report-stat-value">{formatFinite(stats.sharpeRatio)}</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Expectancy</span>
            <span className="report-stat-value">{formatCurrency(stats.expectancy)}</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Max Drawdown</span>
            <span className="report-stat-value text-loss">{formatCurrency(stats.maxDrawdown)}</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-label">Risk:Reward</span>
            <span className="report-stat-value">{formatFinite(stats.riskReward)}</span>
          </div>
        </div>
      </section>

      <section className="report-section">
        <h2>Performance by Pair</h2>
        <table className="report-table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Trades</th>
              <th>Win Rate</th>
              <th>Total PnL</th>
            </tr>
          </thead>
          <tbody>
            {topPairs.map((p) => (
              <tr key={p.pair}>
                <td>{p.pair}</td>
                <td>{p.trades}</td>
                <td>{p.winRate.toFixed(1)}%</td>
                <td className={p.pnl >= 0 ? 'text-profit' : 'text-loss'}>
                  {formatCurrency(p.pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="report-section">
        <h2>Performance by Day of Week</h2>
        <table className="report-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Trades</th>
              <th>Win Rate</th>
              <th>Total PnL</th>
            </tr>
          </thead>
          <tbody>
            {byDay.map((d) => (
              <tr key={d.label}>
                <td>{d.label}</td>
                <td>{d.trades}</td>
                <td>{d.winRate.toFixed(1)}%</td>
                <td className={d.totalPnl >= 0 ? 'text-profit' : 'text-loss'}>
                  {formatCurrency(d.totalPnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="report-section">
        <h2>Recent Trades</h2>
        <table className="report-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Pair</th>
              <th>Direction</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>PnL</th>
              <th>PnL %</th>
            </tr>
          </thead>
          <tbody>
            {[...trades]
              .sort((a, b) => new Date(b.exitDate).getTime() - new Date(a.exitDate).getTime())
              .slice(0, 50)
              .map((t) => (
                <tr key={t.id}>
                  <td>{new Date(t.exitDate).toLocaleDateString()}</td>
                  <td>{t.pair}</td>
                  <td>{t.direction.toUpperCase()}</td>
                  <td>${t.entryPrice.toFixed(2)}</td>
                  <td>${t.exitPrice.toFixed(2)}</td>
                  <td className={t.pnl >= 0 ? 'text-profit' : 'text-loss'}>
                    {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                  </td>
                  <td className={t.pnlPercent >= 0 ? 'text-profit' : 'text-loss'}>
                    {t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <div className="report-footer">
        <p>Generated by TradeVision AI &middot; tradevision-ai-bay.vercel.app</p>
      </div>
    </div>
  );
}
