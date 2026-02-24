'use client';

import { useState, useEffect, useMemo } from 'react';
import { Trade } from '@/types/trade';
import { calculatePnl } from '@/utils/calculations';

interface TradeFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (trade: Trade) => void;
  editTrade?: Trade | null;
}

/** Convert an ISO date string to the `YYYY-MM-DDTHH:mm` format expected by datetime-local inputs. */
function toDatetimeLocal(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Convert a `YYYY-MM-DDTHH:mm` value from a datetime-local input back to an ISO string. */
function fromDatetimeLocal(value: string): string {
  if (!value) return '';
  return new Date(value).toISOString();
}

export default function TradeForm({ isOpen, onClose, onSubmit, editTrade }: TradeFormProps) {
  // ---- form state ----
  const [pair, setPair] = useState('');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [entryPrice, setEntryPrice] = useState('');
  const [exitPrice, setExitPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [leverage, setLeverage] = useState('1');
  const [fees, setFees] = useState('0');
  const [entryDate, setEntryDate] = useState('');
  const [exitDate, setExitDate] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  const [strategy, setStrategy] = useState('');
  const [emotion, setEmotion] = useState<Trade['emotion'] | ''>('');
  const [confidence, setConfidence] = useState<number>(0);
  const [setupType, setSetupType] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [marketCondition, setMarketCondition] = useState<Trade['marketCondition'] | ''>('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ---- populate fields when editing ----
  useEffect(() => {
    if (editTrade) {
      setPair(editTrade.pair);
      setDirection(editTrade.direction);
      setEntryPrice(String(editTrade.entryPrice));
      setExitPrice(String(editTrade.exitPrice));
      setQuantity(String(editTrade.quantity));
      setLeverage(String(editTrade.leverage));
      setFees(String(editTrade.fees));
      setEntryDate(toDatetimeLocal(editTrade.entryDate));
      setExitDate(toDatetimeLocal(editTrade.exitDate));
      setNotes(editTrade.notes);
      setTags(editTrade.tags.join(', '));
      setStrategy(editTrade.strategy ?? '');
      setEmotion(editTrade.emotion ?? '');
      setConfidence(editTrade.confidence ?? 0);
      setSetupType(editTrade.setupType ?? '');
      setTimeframe(editTrade.timeframe ?? '');
      setMarketCondition(editTrade.marketCondition ?? '');
    } else {
      resetForm();
    }
  }, [editTrade, isOpen]);

  function resetForm() {
    setPair('');
    setDirection('long');
    setEntryPrice('');
    setExitPrice('');
    setQuantity('');
    setLeverage('1');
    setFees('0');
    setEntryDate('');
    setExitDate('');
    setNotes('');
    setTags('');
    setStrategy('');
    setEmotion('');
    setConfidence(0);
    setSetupType('');
    setTimeframe('');
    setMarketCondition('');
    setErrors({});
  }

  // ---- live PnL preview ----
  const pnlPreview = useMemo(() => {
    const ep = parseFloat(entryPrice);
    const xp = parseFloat(exitPrice);
    const qty = parseFloat(quantity);
    const lev = parseFloat(leverage);
    const f = parseFloat(fees);

    if (isNaN(ep) || isNaN(xp) || isNaN(qty) || ep <= 0 || qty <= 0) {
      return null;
    }

    const result = calculatePnl({
      pair,
      direction,
      entryPrice: ep,
      exitPrice: xp,
      quantity: qty,
      leverage: isNaN(lev) || lev <= 0 ? 1 : lev,
      fees: isNaN(f) ? 0 : f,
      entryDate: '',
      exitDate: '',
      notes: '',
      tags: [],
    });

    return result;
  }, [entryPrice, exitPrice, quantity, leverage, fees, direction, pair]);

  // ---- validation ----
  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!pair.trim()) newErrors.pair = 'Pair is required';
    if (!entryPrice || isNaN(parseFloat(entryPrice)) || parseFloat(entryPrice) <= 0)
      newErrors.entryPrice = 'Valid entry price is required';
    if (!exitPrice || isNaN(parseFloat(exitPrice)) || parseFloat(exitPrice) <= 0)
      newErrors.exitPrice = 'Valid exit price is required';
    if (!quantity || isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0)
      newErrors.quantity = 'Valid quantity is required';
    if (!entryDate) newErrors.entryDate = 'Entry date is required';
    if (!exitDate) newErrors.exitDate = 'Exit date is required';
    if (entryDate && exitDate && new Date(exitDate) < new Date(entryDate)) {
      newErrors.exitDate = 'Exit date must be after entry date';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  // ---- submit ----
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const ep = parseFloat(entryPrice);
    const xp = parseFloat(exitPrice);
    const qty = parseFloat(quantity);
    const lev = parseFloat(leverage) || 1;
    const f = parseFloat(fees) || 0;
    const parsedTags = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const tradeBase = {
      pair: pair.trim(),
      direction,
      entryPrice: ep,
      exitPrice: xp,
      quantity: qty,
      leverage: lev,
      fees: f,
      entryDate: fromDatetimeLocal(entryDate),
      exitDate: fromDatetimeLocal(exitDate),
      notes: notes.trim(),
      tags: parsedTags,
      strategy: strategy.trim() || undefined,
      emotion: emotion || undefined,
      confidence: confidence > 0 ? confidence : undefined,
      setupType: setupType.trim() || undefined,
      timeframe: timeframe || undefined,
      marketCondition: marketCondition || undefined,
    };

    const { pnl, pnlPercent } = calculatePnl(tradeBase as Omit<Trade, 'id' | 'pnl' | 'pnlPercent'>);

    const trade: Trade = {
      ...tradeBase,
      id: editTrade ? editTrade.id : 'trade-' + Date.now() + Math.random().toString(36).substr(2, 9),
      pnl,
      pnlPercent,
    } as Trade;

    onSubmit(trade);
    resetForm();
    onClose();
  }

  // ---- render ----
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="trade-form-header">
          <h2 className="trade-form-title">{editTrade ? 'Edit Trade' : 'Add New Trade'}</h2>
          <button className="trade-form-close" onClick={onClose} aria-label="Close">
            &#x2715;
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="trade-form-grid">
            {/* Pair */}
            <div className="form-group trade-form-full">
              <label className="form-label">Pair *</label>
              <input
                type="text"
                className={`form-input${errors.pair ? ' error' : ''}`}
                placeholder="BTC/USDT"
                value={pair}
                onChange={(e) => setPair(e.target.value)}
              />
              {errors.pair && <span className="form-error">{errors.pair}</span>}
            </div>

            {/* Direction */}
            <div className="form-group">
              <label className="form-label">Direction *</label>
              <select
                className="form-input"
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'long' | 'short')}
              >
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
            </div>

            {/* Leverage */}
            <div className="form-group">
              <label className="form-label">Leverage</label>
              <input
                type="number"
                className="form-input"
                placeholder="1"
                min="1"
                step="1"
                value={leverage}
                onChange={(e) => setLeverage(e.target.value)}
              />
            </div>

            {/* Entry Price */}
            <div className="form-group">
              <label className="form-label">Entry Price *</label>
              <input
                type="number"
                className={`form-input${errors.entryPrice ? ' error' : ''}`}
                placeholder="0.00"
                min="0"
                step="any"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
              />
              {errors.entryPrice && <span className="form-error">{errors.entryPrice}</span>}
            </div>

            {/* Exit Price */}
            <div className="form-group">
              <label className="form-label">Exit Price *</label>
              <input
                type="number"
                className={`form-input${errors.exitPrice ? ' error' : ''}`}
                placeholder="0.00"
                min="0"
                step="any"
                value={exitPrice}
                onChange={(e) => setExitPrice(e.target.value)}
              />
              {errors.exitPrice && <span className="form-error">{errors.exitPrice}</span>}
            </div>

            {/* Quantity */}
            <div className="form-group">
              <label className="form-label">Quantity *</label>
              <input
                type="number"
                className={`form-input${errors.quantity ? ' error' : ''}`}
                placeholder="0.00"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {errors.quantity && <span className="form-error">{errors.quantity}</span>}
            </div>

            {/* Fees */}
            <div className="form-group">
              <label className="form-label">Fees</label>
              <input
                type="number"
                className="form-input"
                placeholder="0.00"
                min="0"
                step="any"
                value={fees}
                onChange={(e) => setFees(e.target.value)}
              />
            </div>

            {/* Entry Date */}
            <div className="form-group">
              <label className="form-label">Entry Date *</label>
              <input
                type="datetime-local"
                className={`form-input${errors.entryDate ? ' error' : ''}`}
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
              {errors.entryDate && <span className="form-error">{errors.entryDate}</span>}
            </div>

            {/* Exit Date */}
            <div className="form-group">
              <label className="form-label">Exit Date *</label>
              <input
                type="datetime-local"
                className={`form-input${errors.exitDate ? ' error' : ''}`}
                value={exitDate}
                onChange={(e) => setExitDate(e.target.value)}
              />
              {errors.exitDate && <span className="form-error">{errors.exitDate}</span>}
            </div>

            {/* Strategy */}
            <div className="form-group trade-form-full">
              <label className="form-label">Strategy</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. Breakout, Mean Reversion..."
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
              />
            </div>

            {/* Tags */}
            <div className="form-group trade-form-full">
              <label className="form-label">Tags</label>
              <input
                type="text"
                className="form-input"
                placeholder="Comma separated, e.g. scalp, news, momentum"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>

            {/* Notes */}
            <div className="form-group trade-form-full">
              <label className="form-label">Notes</label>
              <textarea
                className="form-input"
                rows={3}
                placeholder="Trade rationale, observations..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {/* Journal Entry Section */}
            <div className="trade-form-full">
              <div className="trade-form-section-title">Journal Entry</div>
            </div>

            {/* Emotion */}
            <div className="form-group">
              <label className="form-label">Emotion</label>
              <select
                className="form-input"
                value={emotion}
                onChange={(e) => setEmotion(e.target.value as Trade['emotion'] | '')}
              >
                <option value="">Select emotion...</option>
                <option value="confident">Confident</option>
                <option value="neutral">Neutral</option>
                <option value="fearful">Fearful</option>
                <option value="greedy">Greedy</option>
                <option value="fomo">FOMO</option>
                <option value="revenge">Revenge</option>
              </select>
            </div>

            {/* Confidence */}
            <div className="form-group">
              <label className="form-label">Confidence</label>
              <div className="trade-form-confidence">
                {[1, 2, 3, 4, 5].map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`confidence-dot${level <= confidence ? ' active' : ''}`}
                    onClick={() => setConfidence(level === confidence ? 0 : level)}
                    title={`Confidence: ${level}/5`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {/* Setup Type */}
            <div className="form-group">
              <label className="form-label">Setup Type</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. breakout, pullback..."
                list="setup-type-suggestions"
                value={setupType}
                onChange={(e) => setSetupType(e.target.value)}
              />
              <datalist id="setup-type-suggestions">
                <option value="breakout" />
                <option value="pullback" />
                <option value="reversal" />
                <option value="range-trade" />
                <option value="trend-follow" />
                <option value="scalp" />
                <option value="swing" />
                <option value="news-trade" />
              </datalist>
            </div>

            {/* Timeframe */}
            <div className="form-group">
              <label className="form-label">Timeframe</label>
              <select
                className="form-input"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                <option value="">Select timeframe...</option>
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="30m">30m</option>
                <option value="1h">1h</option>
                <option value="4h">4h</option>
                <option value="1d">1d</option>
                <option value="1w">1w</option>
              </select>
            </div>

            {/* Market Condition */}
            <div className="form-group trade-form-full">
              <label className="form-label">Market Condition</label>
              <select
                className="form-input"
                value={marketCondition}
                onChange={(e) => setMarketCondition(e.target.value as Trade['marketCondition'] | '')}
              >
                <option value="">Select condition...</option>
                <option value="trending">Trending</option>
                <option value="ranging">Ranging</option>
                <option value="volatile">Volatile</option>
                <option value="calm">Calm</option>
              </select>
            </div>
          </div>

          {/* Live PnL Preview */}
          {pnlPreview !== null && (
            <div className="trade-form-pnl-preview">
              <div className="trade-form-pnl-label">Estimated PnL</div>
              <div
                className="trade-form-pnl-value"
                style={{ color: pnlPreview.pnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}
              >
                {pnlPreview.pnl >= 0 ? '+' : ''}
                {pnlPreview.pnl.toFixed(2)} ({pnlPreview.pnlPercent >= 0 ? '+' : ''}
                {pnlPreview.pnlPercent.toFixed(2)}%)
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="trade-form-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              {editTrade ? 'Update Trade' : 'Add Trade'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
