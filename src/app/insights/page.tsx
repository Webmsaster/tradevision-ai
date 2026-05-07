"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AIInsight } from "@/types/trade";
import { generateAllInsights } from "@/utils/aiAnalysis";
import { useTradeStorage } from "@/hooks/useTradeStorage";
import InsightCard from "@/components/InsightCard";

type FilterType = "all" | "warning" | "positive" | "neutral";

const FILTER_TYPES: ReadonlyArray<FilterType> = [
  "all",
  "warning",
  "positive",
  "neutral",
];

function isFilterType(v: string | null): v is FilterType {
  return v !== null && (FILTER_TYPES as ReadonlyArray<string>).includes(v);
}

// R67-Final: useSearchParams() forces client-side bailout — Next requires
// it under a Suspense boundary so the page can pre-render in the static
// shell.
export default function InsightsPage() {
  return (
    <Suspense
      fallback={
        <div className="page-container">
          <div className="page-header">
            <h1 className="page-title">AI Insights</h1>
            <p className="page-subtitle">
              Pattern detection and trading behavior analysis
            </p>
          </div>
        </div>
      }
    >
      <InsightsPageInner />
    </Suspense>
  );
}

function InsightsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { trades } = useTradeStorage();

  // R67-Final: read initial filter state from URL so reload preserves it.
  // Falls back to defaults if no params present, keeping behaviour
  // equivalent to the pre-persistence version.
  const [activeFilter, setActiveFilter] = useState<FilterType>(() => {
    const v = searchParams.get("filter");
    return isFilterType(v) ? v : "all";
  });
  const [selectedCategory, setSelectedCategory] = useState<string>(
    () => searchParams.get("category") ?? "",
  );
  const [dateFrom, setDateFrom] = useState<string>(
    () => searchParams.get("dateFrom") ?? "",
  );
  const [dateTo, setDateTo] = useState<string>(
    () => searchParams.get("dateTo") ?? "",
  );

  // R67-Final: push filter state back into the URL so reload preserves it.
  // Default values (filter=all, empty category, empty dates) emit no
  // params — URL stays clean and behaviour-equivalent when nothing is set.
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeFilter !== "all") params.set("filter", activeFilter);
    if (selectedCategory) params.set("category", selectedCategory);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    const qs = params.toString();
    const next = qs ? `/insights?${qs}` : "/insights";
    const current =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "";
    if (current !== next) {
      router.replace(next, { scroll: false });
    }
  }, [activeFilter, selectedCategory, dateFrom, dateTo, router]);

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
          <div
            key={insight.id}
            style={{
              // R67-r23 audit fix: cap stagger at 1.5s so users with 50+
              // insights don't wait 5+ seconds for the last card to fade in.
              animationDelay: `${Math.min(index * 0.1, 1.5)}s`,
            }}
          >
            <InsightCard insight={insight} onViewTrades={handleViewTrades} />
          </div>
        ))}
      </div>
    </div>
  );
}
