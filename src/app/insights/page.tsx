"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { AIInsight } from "@/types/trade";
import { generateAllInsights } from "@/utils/aiAnalysis";
import { useTradeStorage } from "@/hooks/useTradeStorage";
import InsightCard from "@/components/InsightCard";

type FilterType = "all" | "warning" | "positive" | "neutral";

export default function InsightsPage() {
  const router = useRouter();
  const { trades } = useTradeStorage();
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const handleViewTrades = (tradeIds: string[]) => {
    const params = new URLSearchParams({ highlight: tradeIds.join(",") });
    router.push(`/trades?${params.toString()}`);
  };

  // Filter trades by date range before generating insights.
  //
  // R67-r21 audit fix: previously `new Date(dateTo)` parsed the bare
  // YYYY-MM-DD as UTC midnight, then `.setHours(23,59,59,999)` applied
  // the LOCAL TZ — in CET/CEST that produced 22:59:59 UTC on the
  // following day, off by one hour. Charts/AI bucket in UTC, so the
  // filter now also pins the boundary in UTC explicitly. Also: invalid
  // input strings used to silently pass-through (`Invalid Date <` was
  // always false → trade survived); we now skip the bound entirely
  // when the parsed date is invalid so the user sees ALL trades, not
  // a silent empty list.
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

  const insights = useMemo<AIInsight[]>(() => {
    if (filteredTrades.length === 0) return [];
    return generateAllInsights(filteredTrades);
  }, [filteredTrades]);

  // Extract unique categories from insights
  const categories = useMemo(() => {
    const cats = new Set(insights.map((i) => i.category));
    return Array.from(cats).sort();
  }, [insights]);

  const filteredInsights = useMemo(() => {
    let filtered =
      activeFilter === "all"
        ? insights
        : insights.filter((insight) => insight.type === activeFilter);

    if (selectedCategory) {
      filtered = filtered.filter(
        (insight) => insight.category === selectedCategory,
      );
    }

    return [...filtered].sort((a, b) => b.severity - a.severity);
  }, [insights, activeFilter, selectedCategory]);

  const warningCount = useMemo(
    () => insights.filter((i) => i.type === "warning").length,
    [insights],
  );
  const positiveCount = useMemo(
    () => insights.filter((i) => i.type === "positive").length,
    [insights],
  );
  const neutralCount = useMemo(
    () => insights.filter((i) => i.type === "neutral").length,
    [insights],
  );

  const tabs: { key: FilterType; label: string; count: number }[] = [
    { key: "all", label: "All", count: insights.length },
    { key: "warning", label: "Warnings", count: warningCount },
    { key: "positive", label: "Positive", count: positiveCount },
    { key: "neutral", label: "Neutral", count: neutralCount },
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

      <div className="insights-filters">
        <div className="insights-filters-group">
          <label className="insights-filter-label">Category</label>
          <select
            className="input insights-category-select"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>
        <div className="insights-filters-group">
          <label className="insights-filter-label">From</label>
          <input
            type="date"
            className="input insights-date-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div className="insights-filters-group">
          <label className="insights-filter-label">To</label>
          <input
            type="date"
            className="input insights-date-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
        {(selectedCategory || dateFrom || dateTo) && (
          <button
            className="insights-filters-clear"
            onClick={() => {
              setSelectedCategory("");
              setDateFrom("");
              setDateTo("");
            }}
          >
            Clear Filters
          </button>
        )}
      </div>

      <div className="insights-filter-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`insights-tab${activeFilter === tab.key ? " active" : ""}`}
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
          <div key={insight.id} style={{ animationDelay: `${index * 0.1}s` }}>
            <InsightCard insight={insight} onViewTrades={handleViewTrades} />
          </div>
        ))}
      </div>
    </div>
  );
}
