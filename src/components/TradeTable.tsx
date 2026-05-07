"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Trade } from "@/types/trade";
import TradeDetailModal from "@/components/TradeDetailModal";
import {
  formatTradeDate,
  formatPrice,
  formatPnl,
  formatPercent,
} from "@/utils/formatters";

interface TradeTableProps {
  trades: Trade[];
  onEdit?: (trade: Trade) => void;
  onDelete?: (tradeId: string) => void;
  compact?: boolean;
}

type SortKey =
  | "exitDate"
  | "pair"
  | "direction"
  | "entryPrice"
  | "exitPrice"
  | "quantity"
  | "leverage"
  | "pnl"
  | "pnlPercent"
  | "fees";

type SortDirection = "asc" | "desc";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// R67-Final (R15-A3 perf): memoised row component.
//
// Before: every parent re-render (sort toggle, page change, parent state
// update unrelated to a specific row) re-rendered ALL N rows because the
// inline arrow handlers (`onClick`, `onKeyDown`) on the <tr> were fresh
// functions each render — React's reconciler had nothing to bail out on.
//
// After: the row body is a separate memo'd component receiving ONLY the
// data it needs (trade + stable callbacks hoisted via useCallback in the
// parent). Sorting now re-creates the array but each individual row's
// props are reference-stable as long as `trade`, `compact`, `onSelect`,
// `onEdit`, `onDelete` haven't changed → 25 rows on a page-change render
// reduce to ~1-2 actual DOM diffs instead of 25 full re-renders.
// ---------------------------------------------------------------------------
interface TradeRowProps {
  trade: Trade;
  compact: boolean;
  onSelect: (trade: Trade) => void;
  onEdit?: (trade: Trade) => void;
  onDelete?: (tradeId: string) => void;
}

const TradeRow = memo(function TradeRow({
  trade,
  compact,
  onSelect,
  onEdit,
  onDelete,
}: TradeRowProps) {
  const handleRowClick = useCallback(() => {
    onSelect(trade);
  }, [onSelect, trade]);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(trade);
      }
    },
    [onSelect, trade],
  );

  const handleEditClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onEdit?.(trade);
    },
    [onEdit, trade],
  );

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onDelete?.(trade.id);
    },
    [onDelete, trade.id],
  );

  return (
    <tr
      role="row"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      style={{ cursor: "pointer" }}
    >
      <td>
        {/* R67-Final (R15-A3 perf): prefer the pre-parsed numeric cache
            so we don't re-parse the ISO string on every render. Falls
            back to the string for trades that predate the cache. */}
        {formatTradeDate(trade.exitMs ?? trade.exitDate, {
          displayInUTC: true,
        })}
      </td>
      <td>{trade.pair}</td>
      <td>
        <span
          className={`direction-badge ${
            trade.direction === "long" ? "long" : "short"
          }`}
        >
          {trade.direction === "long" ? "LONG" : "SHORT"}
        </span>
      </td>
      {!compact && <td>{formatPrice(trade.entryPrice)}</td>}
      {!compact && <td>{formatPrice(trade.exitPrice)}</td>}
      {!compact && <td>{trade.quantity}</td>}
      {!compact && <td>{trade.leverage ?? 1}x</td>}
      <td className={trade.pnl >= 0 ? "pnl-positive" : "pnl-negative"}>
        {formatPnl(trade.pnl)}
      </td>
      <td className={trade.pnlPercent >= 0 ? "pnl-positive" : "pnl-negative"}>
        {formatPercent(trade.pnlPercent)}
      </td>
      {!compact && (
        <td>{trade.fees != null ? formatPrice(trade.fees) : "-"}</td>
      )}
      {!compact && (
        <td>
          <div className="table-actions">
            {onEdit && (
              <button
                className="table-action-btn"
                onClick={handleEditClick}
                title="Edit trade"
                aria-label={`Edit trade ${trade.pair}`}
              >
                &#9998;
              </button>
            )}
            {onDelete && (
              <button
                className="table-action-btn delete"
                onClick={handleDeleteClick}
                title="Delete trade"
                aria-label={`Delete trade ${trade.pair}`}
              >
                &#128465;
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
});

export default function TradeTable({
  trades,
  onEdit,
  onDelete,
  compact = false,
}: TradeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("exitDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // R67-r5 audit: revert to length-based reset. Reference-based reset
  // jumped to page 1 on every single trade-edit (storage hooks return new
  // array on every mutation) — bad UX. Length-based misses re-filters
  // that keep same length, but that edge case is far less annoying.
  useEffect(() => {
    setCurrentPage(1);
  }, [trades.length]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const sortedTrades = useMemo(() => {
    const sorted = [...trades].sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sortKey) {
        case "exitDate":
          // R67-Final (R15-A3 perf): prefer the cached epoch-ms over
          // re-parsing `new Date(...)` on every comparator call. For
          // 10k trades this is a 20k+ saved Date constructions per
          // sort.
          aVal = a.exitMs ?? new Date(a.exitDate).getTime();
          bVal = b.exitMs ?? new Date(b.exitDate).getTime();
          break;
        case "pair":
          aVal = a.pair.toLowerCase();
          bVal = b.pair.toLowerCase();
          break;
        case "direction":
          aVal = a.direction;
          bVal = b.direction;
          break;
        case "entryPrice":
          aVal = a.entryPrice;
          bVal = b.entryPrice;
          break;
        case "exitPrice":
          aVal = a.exitPrice;
          bVal = b.exitPrice;
          break;
        case "quantity":
          aVal = a.quantity;
          bVal = b.quantity;
          break;
        case "leverage":
          aVal = a.leverage ?? 1;
          bVal = b.leverage ?? 1;
          break;
        case "pnl":
          aVal = a.pnl;
          bVal = b.pnl;
          break;
        case "pnlPercent":
          aVal = a.pnlPercent;
          bVal = b.pnlPercent;
          break;
        case "fees":
          aVal = a.fees ?? 0;
          bVal = b.fees ?? 0;
          break;
        default:
          return 0;
      }

      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDirection === "asc"
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === "asc" ? numA - numB : numB - numA;
    });

    return sorted;
  }, [trades, sortKey, sortDirection]);

  // Clamp currentPage if the data shrinks below the current page boundary
  // (e.g. after delete or filter reduces total pages).
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedTrades.length / PAGE_SIZE));
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [sortedTrades.length, currentPage]);

  const renderSortHeader = (label: string, key: SortKey) => {
    const isSorted = sortKey === key;
    const arrow = isSorted ? (sortDirection === "asc" ? "▲" : "▼") : "";

    // Determine aria-sort value for the column header
    const ariaSortValue: "ascending" | "descending" | "none" = isSorted
      ? sortDirection === "asc"
        ? "ascending"
        : "descending"
      : "none";

    return (
      <th
        scope="col"
        role="columnheader"
        aria-sort={ariaSortValue}
        className={isSorted ? "sorted" : ""}
        onClick={() => handleSort(key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleSort(key);
          }
        }}
        tabIndex={0}
        style={{ cursor: "pointer" }}
      >
        {label}
        {arrow && <span className="sort-arrow">{arrow}</span>}
      </th>
    );
  };

  // Pagination
  const totalPages = compact ? 1 : Math.ceil(sortedTrades.length / PAGE_SIZE);
  const paginatedTrades = compact
    ? sortedTrades
    : sortedTrades.slice(
        (currentPage - 1) * PAGE_SIZE,
        currentPage * PAGE_SIZE,
      );

  // R67-Final (R15-A3 perf): hoist the row callbacks via useCallback so
  // the memo'd <TradeRow> children skip re-renders when nothing about
  // their own data changed. Without this, every re-render of
  // TradeTable would create fresh function references for each child
  // row → React.memo's prop-equality always mismatches → memoization
  // ineffective.
  const handleSelect = useCallback((trade: Trade) => {
    setSelectedTrade(trade);
  }, []);

  const handleCloseModal = useCallback(() => {
    setSelectedTrade(null);
  }, []);

  if (trades.length === 0) {
    return (
      <div className="trade-table-wrapper">
        <div className="trade-table-empty">
          <p>
            No trades to display. Start logging your trades to see them here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="trade-table-wrapper">
      <div className="trade-table-scroll">
        <table className="trade-table">
          {/* Round 58 a11y (WCAG 1.3.1): screen-reader-only caption so
              assistive tech announces the table's purpose & row count. */}
          <caption className="sr-only">
            Trades — sortable by clicking any column header. {trades.length}{" "}
            entries.
          </caption>
          <thead>
            <tr>
              {renderSortHeader("Date", "exitDate")}
              {renderSortHeader("Pair", "pair")}
              {renderSortHeader("Direction", "direction")}
              {!compact && renderSortHeader("Entry", "entryPrice")}
              {!compact && renderSortHeader("Exit", "exitPrice")}
              {!compact && renderSortHeader("Qty", "quantity")}
              {!compact && renderSortHeader("Leverage", "leverage")}
              {renderSortHeader("PnL ($)", "pnl")}
              {renderSortHeader("PnL (%)", "pnlPercent")}
              {!compact && renderSortHeader("Fees", "fees")}
              {!compact && (
                <th scope="col" role="columnheader">
                  Actions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {paginatedTrades.map((trade) => (
              <TradeRow
                key={trade.id}
                trade={trade}
                compact={compact}
                onSelect={handleSelect}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {!compact && totalPages > 1 && (
        <div className="trade-table-pagination">
          <button
            className="btn btn-ghost btn-sm"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="trade-table-page-info">
            Page {currentPage} of {totalPages} ({sortedTrades.length} trades)
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}

      <TradeDetailModal
        trade={selectedTrade}
        isOpen={!!selectedTrade}
        onClose={handleCloseModal}
      />
    </div>
  );
}
