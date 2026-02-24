'use client';

import { Trade } from '@/types/trade';

interface TradeDetailModalProps {
  trade: Trade | null;
  isOpen: boolean;
  onClose: () => void;
}

function formatDetailDate(dateStr: string): string {
  const d = new Date(dateStr);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const month = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year} ${hours}:${minutes}`;
}

function formatHoldTime(entryDate: string, exitDate: string): string {
  const diffMs = new Date(exitDate).getTime() - new Date(entryDate).getTime();
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPnl(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export default function TradeDetailModal({ trade, isOpen, onClose }: TradeDetailModalProps) {
  if (!isOpen || !trade) {
    return null;
  }

  const pnlColor = trade.pnl >= 0 ? 'var(--profit)' : 'var(--loss)';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="trade-detail-header">
          <span className="trade-detail-pair">{trade.pair}</span>
          <span className={`trade-detail-direction ${trade.direction}`}>
            {trade.direction === 'long' ? 'LONG' : 'SHORT'}
          </span>
          <button className="trade-detail-close" onClick={onClose} title="Close">
            &#10005;
          </button>
        </div>

        <div className="trade-detail-divider" />

        {/* Info Grid */}
        <div className="trade-detail-grid">
          {/* Row 1 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Entry Price</span>
            <span className="trade-detail-item-value">{formatPrice(trade.entryPrice)}</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Exit Price</span>
            <span className="trade-detail-item-value">{formatPrice(trade.exitPrice)}</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Quantity</span>
            <span className="trade-detail-item-value">{trade.quantity}</span>
          </div>

          {/* Row 2 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Entry Date</span>
            <span className="trade-detail-item-value">{formatDetailDate(trade.entryDate)}</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Exit Date</span>
            <span className="trade-detail-item-value">{formatDetailDate(trade.exitDate)}</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Hold Time</span>
            <span className="trade-detail-item-value">
              {formatHoldTime(trade.entryDate, trade.exitDate)}
            </span>
          </div>

          {/* Row 3 */}
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Leverage</span>
            <span className="trade-detail-item-value">{trade.leverage ?? 1}x</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Fees</span>
            <span className="trade-detail-item-value">{formatPrice(trade.fees)}</span>
          </div>
          <div className="trade-detail-item">
            <span className="trade-detail-item-label">Strategy</span>
            <span className="trade-detail-item-value">{trade.strategy || 'N/A'}</span>
          </div>
        </div>

        {/* Journal Entry Fields */}
        {(trade.emotion || trade.confidence || trade.setupType || trade.timeframe || trade.marketCondition) && (
          <>
            <div className="trade-detail-divider" />
            <div className="trade-detail-journal-title">Journal Entry</div>
            <div className="trade-detail-grid">
              {trade.emotion && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Emotion</span>
                  <span className="trade-detail-item-value">
                    <span className={`trade-detail-emotion trade-detail-emotion--${trade.emotion}`}>
                      {trade.emotion === 'confident' && 'Confident'}
                      {trade.emotion === 'neutral' && 'Neutral'}
                      {trade.emotion === 'fearful' && 'Fearful'}
                      {trade.emotion === 'greedy' && 'Greedy'}
                      {trade.emotion === 'fomo' && 'FOMO'}
                      {trade.emotion === 'revenge' && 'Revenge'}
                    </span>
                  </span>
                </div>
              )}
              {trade.confidence && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Confidence</span>
                  <span className="trade-detail-item-value">
                    <span className="trade-detail-confidence">
                      {[1, 2, 3, 4, 5].map((level) => (
                        <span
                          key={level}
                          className={`trade-detail-confidence-dot${level <= trade.confidence! ? ' active' : ''}`}
                        />
                      ))}
                    </span>
                  </span>
                </div>
              )}
              {trade.setupType && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Setup Type</span>
                  <span className="trade-detail-item-value">{trade.setupType}</span>
                </div>
              )}
              {trade.timeframe && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Timeframe</span>
                  <span className="trade-detail-item-value">{trade.timeframe}</span>
                </div>
              )}
              {trade.marketCondition && (
                <div className="trade-detail-item">
                  <span className="trade-detail-item-label">Market Condition</span>
                  <span className="trade-detail-item-value" style={{ textTransform: 'capitalize' }}>
                    {trade.marketCondition}
                  </span>
                </div>
              )}
            </div>
          </>
        )}

        {/* PnL Hero */}
        <div className="trade-detail-pnl">
          <div className="trade-detail-pnl-value" style={{ color: pnlColor }}>
            {formatPnl(trade.pnl)}
          </div>
          <div className="trade-detail-pnl-percent" style={{ color: pnlColor }}>
            {formatPercent(trade.pnlPercent)}
          </div>
        </div>

        {/* Tags */}
        {trade.tags && trade.tags.length > 0 && (
          <div className="trade-detail-tags">
            {trade.tags.map((tag, index) => (
              <span key={index} className="trade-detail-tag">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Notes */}
        {trade.notes && (
          <div className="trade-detail-notes">
            <div className="trade-detail-notes-label">Notes</div>
            <div className="trade-detail-notes-text">{trade.notes}</div>
          </div>
        )}

        {/* Footer */}
        <div className="trade-detail-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
