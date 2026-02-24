'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Trade, AIInsight } from '@/types/trade';
import { loadTrades } from '@/utils/storage';
import { generateAllInsights } from '@/utils/aiAnalysis';
import InsightCard from '@/components/InsightCard';

type FilterType = 'all' | 'warning' | 'positive' | 'neutral';

export default function InsightsPage() {
  const router = useRouter();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  const handleViewTrades = (tradeIds: string[]) => {
    const params = new URLSearchParams({ highlight: tradeIds.join(',') });
    router.push(`/trades?${params.toString()}`);
  };

  useEffect(() => {
    const storedTrades = loadTrades();
    setTrades(storedTrades);

    if (storedTrades.length > 0) {
      const allInsights = generateAllInsights(storedTrades);
      setInsights(allInsights);
    }
  }, []);

  const filteredInsights = useMemo(() => {
    const filtered =
      activeFilter === 'all'
        ? insights
        : insights.filter((insight) => insight.type === activeFilter);

    return [...filtered].sort((a, b) => b.severity - a.severity);
  }, [insights, activeFilter]);

  const warningCount = useMemo(
    () => insights.filter((i) => i.type === 'warning').length,
    [insights]
  );
  const positiveCount = useMemo(
    () => insights.filter((i) => i.type === 'positive').length,
    [insights]
  );
  const neutralCount = useMemo(
    () => insights.filter((i) => i.type === 'neutral').length,
    [insights]
  );

  const tabs: { key: FilterType; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: insights.length },
    { key: 'warning', label: 'Warnings', count: warningCount },
    { key: 'positive', label: 'Positive', count: positiveCount },
    { key: 'neutral', label: 'Neutral', count: neutralCount },
  ];

  if (trades.length === 0) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">AI Insights</h1>
          <p className="page-subtitle">
            Pattern detection and trading behavior analysis
          </p>
        </div>
        <div className="insights-empty">
          <div className="insights-empty-icon">📊</div>
          <div className="insights-empty-title">No trades found</div>
          <p className="insights-empty-text">
            Import or add trades to unlock AI-powered pattern detection and
            coaching insights. The more data you provide, the better the
            analysis.
          </p>
        </div>
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1 className="page-title">AI Insights</h1>
          <p className="page-subtitle">
            Pattern detection and trading behavior analysis
          </p>
        </div>
        <div className="insights-empty">
          <div className="insights-empty-icon">✨</div>
          <div className="insights-empty-title">No patterns detected yet</div>
          <p className="insights-empty-text">
            Keep trading and check back when you have more data. The AI engine
            needs sufficient trade history to identify meaningful patterns and
            provide coaching insights.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">AI Insights</h1>
        <p className="page-subtitle">
          Pattern detection and trading behavior analysis
        </p>
      </div>

      <div className="insights-filter-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`insights-tab${activeFilter === tab.key ? ' active' : ''}`}
            onClick={() => setActiveFilter(tab.key)}
          >
            {tab.label}
            <span className="insights-tab-count">{tab.count}</span>
          </button>
        ))}
      </div>

      <div className="insights-stats">
        <div className="insights-stat">
          <span className="insights-stat-value">{insights.length}</span>
          <span className="insights-stat-label">Total Insights</span>
        </div>
        <div className="insights-stat">
          <span className="insights-stat-dot warning" />
          <span className="insights-stat-value">{warningCount}</span>
          <span className="insights-stat-label">Warnings</span>
        </div>
        <div className="insights-stat">
          <span className="insights-stat-dot positive" />
          <span className="insights-stat-value">{positiveCount}</span>
          <span className="insights-stat-label">Positive</span>
        </div>
        <div className="insights-stat">
          <span className="insights-stat-dot neutral" />
          <span className="insights-stat-value">{neutralCount}</span>
          <span className="insights-stat-label">Neutral</span>
        </div>
      </div>

      <div className="insights-list">
        {filteredInsights.map((insight, index) => (
          <div
            key={insight.id}
            style={{ animationDelay: `${index * 0.1}s` }}
          >
            <InsightCard insight={insight} onViewTrades={handleViewTrades} />
          </div>
        ))}
      </div>
    </div>
  );
}
