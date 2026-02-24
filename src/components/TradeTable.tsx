'use client';

import { useState, useMemo } from 'react';
import { Trade } from '@/types/trade';
import TradeDetailModal from '@/components/TradeDetailModal';

interface TradeTableProps {
  trades: Trade[];
  onEdit?: (trade: Trade) => void;
  onDelete?: (tradeId: string) => void;
  compact?: boolean;
}

type SortKey =
  | 'exitDate'
  | 'pair'
  | 'direction'
  | 'entryPrice'
  | 'exitPrice'
  | 'quantity'
  | 'leverage'
  | 'pnl'
  | 'pnlPercent'
  | 'fees';

type SortDirection = 'asc' | 'desc';

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hours}:${minutes}`;
}

function formatPrice(value: number): string {
  return value.toFixed(2);
}

function formatPnl(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export default function TradeTable({
  trades,
  onEdit,
  onDelete,
  compact = false,
}: TradeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('exitDate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const sortedTrades = useMemo(() => {
    const sorted = [...trades].sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sortKey) {
        case 'exitDate':
          aVal = new Date(a.exitDate).getTime();
          bVal = new Date(b.exitDate).getTime();
          break;
        case 'pair':
          aVal = a.pair.toLowerCase();
          bVal = b.pair.toLowerCase();
          break;
        case 'direction':
          aVal = a.direction;
          bVal = b.direction;
          break;
        case 'entryPrice':
          aVal = a.entryPrice;
          bVal = b.entryPrice;
          break;
        case 'exitPrice':
          aVal = a.exitPrice;
          bVal = b.exitPrice;
          break;
        case 'quantity':
          aVal = a.quantity;
          bVal = b.quantity;
          break;
        case 'leverage':
          aVal = a.leverage ?? 1;
          bVal = b.leverage ?? 1;
          break;
        case 'pnl':
          aVal = a.pnl;
          bVal = b.pnl;
          break;
        case 'pnlPercent':
          aVal = a.pnlPercent;
          bVal = b.pnlPercent;
          break;
        case 'fees':
          aVal = a.fees ?? 0;
          bVal = b.fees ?? 0;
          break;
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      const numA = aVal as number;
      const numB = bVal as number;
      return sortDirection === 'asc' ? numA - numB : numB - numA;
    });

    return sorted;
  }, [trades, sortKey, sortDirection]);

  const renderSortHeader = (label: string, key: SortKey) => {
    const isSorted = sortKey === key;
    const arrow = isSorted
      ? sortDirection === 'asc'
        ? '\u25B2'
        : '\u25BC'
      : '';

    return (
      <th
        className={isSorted ? 'sorted' : ''}
        onClick={() => handleSort(key)}
      >
        {label}
        {arrow && <span className="sort-arrow">{arrow}</span>}
      </th>
    );
  };

  if (trades.length === 0) {
    return (
      <div className="trade-table-wrapper">
        <div className="trade-table-empty">
          <p>No trades to display. Start logging your trades to see them here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="trade-table-wrapper">
      <div className="trade-table-scroll">
        <table className="trade-table">
          <thead>
            <tr>
              {renderSortHeader('Date', 'exitDate')}
              {renderSortHeader('Pair', 'pair')}
              {renderSortHeader('Direction', 'direction')}
              {!compact && renderSortHeader('Entry', 'entryPrice')}
              {!compact && renderSortHeader('Exit', 'exitPrice')}
              {!compact && renderSortHeader('Qty', 'quantity')}
              {!compact && renderSortHeader('Leverage', 'leverage')}
              {renderSortHeader('PnL ($)', 'pnl')}
              {renderSortHeader('PnL (%)', 'pnlPercent')}
              {!compact && renderSortHeader('Fees', 'fees')}
              {!compact && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedTrades.map((trade) => (
              <tr key={trade.id} onClick={() => setSelectedTrade(trade)} style={{ cursor: 'pointer' }}>
                <td>{formatDate(trade.exitDate)}</td>
                <td>{trade.pair}</td>
                <td>
                  <span
                    className={`direction-badge ${
                      trade.direction === 'long' ? 'long' : 'short'
                    }`}
                  >
                    {trade.direction === 'long' ? 'LONG' : 'SHORT'}
                  </span>
                </td>
                {!compact && <td>{formatPrice(trade.entryPrice)}</td>}
                {!compact && <td>{formatPrice(trade.exitPrice)}</td>}
                {!compact && <td>{trade.quantity}</td>}
                {!compact && <td>{trade.leverage ?? 1}x</td>}
                <td className={trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {formatPnl(trade.pnl)}
                </td>
                <td
                  className={
                    trade.pnlPercent >= 0 ? 'pnl-positive' : 'pnl-negative'
                  }
                >
                  {formatPercent(trade.pnlPercent)}
                </td>
                {!compact && (
                  <td>{trade.fees != null ? formatPrice(trade.fees) : '—'}</td>
                )}
                {!compact && (
                  <td>
                    <div className="table-actions">
                      {onEdit && (
                        <button
                          className="table-action-btn"
                          onClick={(e) => { e.stopPropagation(); onEdit(trade); }}
                          title="Edit trade"
                        >
                          &#9998;
                        </button>
                      )}
                      {onDelete && (
                        <button
                          className="table-action-btn delete"
                          onClick={(e) => { e.stopPropagation(); onDelete(trade.id); }}
                          title="Delete trade"
                        >
                          &#128465;
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TradeDetailModal
        trade={selectedTrade}
        isOpen={!!selectedTrade}
        onClose={() => setSelectedTrade(null)}
      />
    </div>
  );
}
