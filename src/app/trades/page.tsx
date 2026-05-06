"use client";
import {
  Suspense,
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from "react";
import { useSearchParams } from "next/navigation";
import { Trade } from "@/types/trade";
import { useTradeStorage } from "@/hooks/useTradeStorage";
import TradeTable from "@/components/TradeTable";
import TradeForm from "@/components/TradeForm";
import ConfirmDialog from "@/components/ConfirmDialog";
import SyncErrorToast from "@/components/SyncErrorToast";
import { exportTradesToCsv } from "@/utils/csvExport";

export default function TradesPage() {
  return (
    <Suspense>
      <TradesPageContent />
    </Suspense>
  );
}

function TradesPageContent() {
  const {
    trades,
    addTrade,
    editTrade,
    removeTrade,
    syncError,
    dismissSyncError,
  } = useTradeStorage();
  const searchParams = useSearchParams();
  const highlightIds = useMemo(() => {
    const raw = searchParams.get("highlight");
    return raw ? new Set(raw.split(",")) : null;
  }, [searchParams]);
  const [showForm, setShowForm] = useState(false);
  const [editingTrade, setEditingTrade] = useState<Trade | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<
    "all" | "long" | "short"
  >("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filteredTrades = useMemo(() => {
    // When highlight param is set, only show those trades
    if (
      highlightIds &&
      !searchQuery &&
      directionFilter === "all" &&
      !dateFrom &&
      !dateTo
    ) {
      return trades.filter((t) => highlightIds.has(t.id));
    }
    return trades.filter((trade) => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const haystack = [
          trade.pair,
          trade.notes ?? "",
          trade.strategy ?? "",
          trade.setupType ?? "",
          (trade.tags ?? []).join(" "),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) {
          return false;
        }
      }

      if (directionFilter !== "all" && trade.direction !== directionFilter) {
        return false;
      }

      if (dateFrom) {
        const tradeDate = trade.exitDate
          ? trade.exitDate.slice(0, 10)
          : trade.entryDate.slice(0, 10);
        if (tradeDate < dateFrom) {
          return false;
        }
      }

      if (dateTo) {
        const tradeDate = trade.exitDate
          ? trade.exitDate.slice(0, 10)
          : trade.entryDate.slice(0, 10);
        if (tradeDate > dateTo) {
          return false;
        }
      }

      return true;
    });
  }, [trades, searchQuery, directionFilter, dateFrom, dateTo, highlightIds]);

  const hasActiveFilters =
    searchQuery !== "" ||
    directionFilter !== "all" ||
    dateFrom !== "" ||
    dateTo !== "";
  const isHighlightMode = highlightIds && !hasActiveFilters;

  const totalPnl = useMemo(() => {
    return filteredTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  }, [filteredTrades]);

  const winRate = useMemo(() => {
    if (filteredTrades.length === 0) return 0;
    const wins = filteredTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    return (wins / filteredTrades.length) * 100;
  }, [filteredTrades]);

  function clearFilters() {
    setSearchQuery("");
    setDirectionFilter("all");
    setDateFrom("");
    setDateTo("");
  }

  // TradeForm already returns a complete Trade with id, pnl, pnlPercent
  function handleAddTrade(trade: Trade) {
    addTrade(trade);
    setShowForm(false);
  }

  function handleUpdateTrade(trade: Trade) {
    editTrade(trade);
    setEditingTrade(null);
    setShowForm(false);
  }

  // Undo state for trade deletion
  const [undoTrade, setUndoTrade] = useState<Trade | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  function dismissUndo() {
    setUndoTrade(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }

  function handleUndoDelete() {
    if (undoTrade) {
      addTrade(undoTrade);
      dismissUndo();
    }
  }

  // Confirm dialog state for trade deletion
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function handleDeleteTrade(id: string) {
    setConfirmDeleteId(id);
  }

  function confirmDelete() {
    if (!confirmDeleteId) return;
    const tradeToDelete = trades.find((t) => t.id === confirmDeleteId);
    removeTrade(confirmDeleteId);
    setConfirmDeleteId(null);

    // Show undo toast
    if (tradeToDelete) {
      setUndoTrade(tradeToDelete);
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setUndoTrade(null), 5000);
    }
  }

  function handleEdit(trade: Trade) {
    setEditingTrade(trade);
    setShowForm(true);
  }

  const handleCloseForm = useCallback(() => {
    setShowForm(false);
    setEditingTrade(null);
  }, []);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Trade History</h1>
          <p className="page-subtitle">
            View, filter, and manage all your trades
          </p>
        </div>
        <div className="page-header-actions">
          <button
            className="btn btn-ghost"
            onClick={() => exportTradesToCsv(filteredTrades)}
            disabled={filteredTrades.length === 0}
            title="Export filtered trades as CSV"
          >
            Export CSV
          </button>
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            + Add Trade
          </button>
        </div>
      </div>

      {isHighlightMode && (
        <div className="dashboard-banner" style={{ marginBottom: 16 }}>
          <span className="dashboard-banner-text">
            Showing {filteredTrades.length} related trade
            {filteredTrades.length !== 1 ? "s" : ""} from insight
          </span>
          <a href="/trades" className="dashboard-banner-btn">
            Show All Trades
          </a>
        </div>
      )}

      <div className="trades-filters">
        <input
          type="text"
          className="input trades-search"
          placeholder="Search pair, notes, tags, strategy..."
          aria-label="Search trades by pair, notes, tags, strategy or setup type"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div
          className="trades-direction-filter"
          role="group"
          aria-label="Filter by direction"
        >
          <button
            className={`trades-direction-btn ${directionFilter === "all" ? "active" : ""}`}
            onClick={() => setDirectionFilter("all")}
          >
            All
          </button>
          <button
            className={`trades-direction-btn ${directionFilter === "long" ? "active" : ""}`}
            onClick={() => setDirectionFilter("long")}
          >
            Long
          </button>
          <button
            className={`trades-direction-btn ${directionFilter === "short" ? "active" : ""}`}
            onClick={() => setDirectionFilter("short")}
          >
            Short
          </button>
        </div>

        <div className="trades-date-inputs">
          <label htmlFor="filter-date-from">From</label>
          <input
            id="filter-date-from"
            type="date"
            className="input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <label htmlFor="filter-date-to">To</label>
          <input
            id="filter-date-to"
            type="date"
            className="input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>

        {hasActiveFilters && (
          <button className="btn btn-ghost" onClick={clearFilters}>
            Clear Filters
          </button>
        )}
      </div>

      <div className="trades-summary">
        <span>
          Showing{" "}
          <span className="trades-summary-stat">{filteredTrades.length}</span>{" "}
          of <span className="trades-summary-stat">{trades.length}</span> trades
        </span>
        <span>
          Total PnL:{" "}
          <span
            className="trades-summary-stat"
            style={{ color: totalPnl >= 0 ? "var(--profit)" : "var(--loss)" }}
          >
            $
            {totalPnl.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </span>
        <span>
          Win Rate:{" "}
          <span className="trades-summary-stat">{winRate.toFixed(1)}%</span>
        </span>
      </div>

      <TradeTable
        trades={filteredTrades}
        onEdit={handleEdit}
        onDelete={handleDeleteTrade}
      />

      <TradeForm
        isOpen={showForm}
        editTrade={editingTrade}
        onSubmit={editingTrade ? handleUpdateTrade : handleAddTrade}
        onClose={handleCloseForm}
      />

      <ConfirmDialog
        isOpen={!!confirmDeleteId}
        title="Delete Trade"
        message="Are you sure you want to delete this trade?"
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {undoTrade && (
        <div className="undo-toast">
          <span>Trade deleted</span>
          <button className="btn btn-ghost btn-sm" onClick={handleUndoDelete}>
            Undo
          </button>
          <button
            className="undo-toast-dismiss"
            onClick={dismissUndo}
            aria-label="Dismiss"
          >
            &#10005;
          </button>
        </div>
      )}

      <SyncErrorToast message={syncError} onDismiss={dismissSyncError} />
    </div>
  );
}
