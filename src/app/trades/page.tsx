'use client';
import { useState, useMemo } from 'react';
import { Trade } from '@/types/trade';
import { calculatePnl } from '@/utils/calculations';
import { useTradeStorage } from '@/hooks/useTradeStorage';
import TradeTable from '@/components/TradeTable';
import TradeForm from '@/components/TradeForm';

export default function TradesPage() {
  const { trades, addTrade, editTrade, removeTrade } = useTradeStorage();
  const [showForm, setShowForm] = useState(false);
  const [editingTrade, setEditingTrade] = useState<Trade | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'long' | 'short'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const filteredTrades = useMemo(() => {
    return trades.filter((trade) => {
      if (searchQuery && !trade.pair.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      if (directionFilter !== 'all' && trade.direction !== directionFilter) {
        return false;
      }

      if (dateFrom) {
        const tradeDate = trade.exitDate ? trade.exitDate.slice(0, 10) : trade.entryDate.slice(0, 10);
        if (tradeDate < dateFrom) {
          return false;
        }
      }

      if (dateTo) {
        const tradeDate = trade.exitDate ? trade.exitDate.slice(0, 10) : trade.entryDate.slice(0, 10);
        if (tradeDate > dateTo) {
          return false;
        }
      }

      return true;
    });
  }, [trades, searchQuery, directionFilter, dateFrom, dateTo]);

  const hasActiveFilters = searchQuery !== '' || directionFilter !== 'all' || dateFrom !== '' || dateTo !== '';

  const totalPnl = useMemo(() => {
    return filteredTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  }, [filteredTrades]);

  const winRate = useMemo(() => {
    if (filteredTrades.length === 0) return 0;
    const wins = filteredTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    return (wins / filteredTrades.length) * 100;
  }, [filteredTrades]);

  function clearFilters() {
    setSearchQuery('');
    setDirectionFilter('all');
    setDateFrom('');
    setDateTo('');
  }

  function handleAddTrade(trade: Omit<Trade, 'id' | 'pnl' | 'pnlPercent'>) {
    const pnlResult = calculatePnl(trade);
    const newTrade: Trade = {
      ...trade,
      id: crypto.randomUUID(),
      pnl: pnlResult.pnl,
      pnlPercent: pnlResult.pnlPercent,
    };
    addTrade(newTrade);
    setShowForm(false);
  }

  function handleUpdateTrade(trade: Trade) {
    const pnlResult = calculatePnl(trade);
    const updatedTrade: Trade = {
      ...trade,
      pnl: pnlResult.pnl,
      pnlPercent: pnlResult.pnlPercent,
    };
    editTrade(updatedTrade);
    setEditingTrade(null);
    setShowForm(false);
  }

  function handleDeleteTrade(id: string) {
    const confirmed = window.confirm('Are you sure you want to delete this trade? This action cannot be undone.');
    if (!confirmed) return;
    removeTrade(id);
  }

  function handleEdit(trade: Trade) {
    setEditingTrade(trade);
    setShowForm(true);
  }

  function handleCloseForm() {
    setShowForm(false);
    setEditingTrade(null);
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Trade History</h1>
          <p className="page-subtitle">View, filter, and manage all your trades</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          + Add Trade
        </button>
      </div>

      <div className="trades-filters">
        <input
          type="text"
          className="input trades-search"
          placeholder="Search by pair (e.g. BTC/USD)..."
          aria-label="Search trades by pair"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="trades-direction-filter" role="group" aria-label="Filter by direction">
          <button
            className={`trades-direction-btn ${directionFilter === 'all' ? 'active' : ''}`}
            onClick={() => setDirectionFilter('all')}
          >
            All
          </button>
          <button
            className={`trades-direction-btn ${directionFilter === 'long' ? 'active' : ''}`}
            onClick={() => setDirectionFilter('long')}
          >
            Long
          </button>
          <button
            className={`trades-direction-btn ${directionFilter === 'short' ? 'active' : ''}`}
            onClick={() => setDirectionFilter('short')}
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
          Showing <span className="trades-summary-stat">{filteredTrades.length}</span> of{' '}
          <span className="trades-summary-stat">{trades.length}</span> trades
        </span>
        <span>
          Total PnL:{' '}
          <span
            className="trades-summary-stat"
            style={{ color: totalPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
          >
            ${totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </span>
        <span>
          Win Rate: <span className="trades-summary-stat">{winRate.toFixed(1)}%</span>
        </span>
      </div>

      <TradeTable trades={filteredTrades} onEdit={handleEdit} onDelete={handleDeleteTrade} />

      <TradeForm
        isOpen={showForm}
        editTrade={editingTrade}
        onSubmit={editingTrade ? handleUpdateTrade : handleAddTrade}
        onClose={handleCloseForm}
      />
    </div>
  );
}
