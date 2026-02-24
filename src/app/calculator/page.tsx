'use client';

import { useState, useMemo } from 'react';
import StatCard from '@/components/StatCard';

type Direction = 'long' | 'short';

const RISK_PRESETS = [0.5, 1, 2, 3];

export default function CalculatorPage() {
  const [accountBalance, setAccountBalance] = useState<number>(10000);
  const [riskPercent, setRiskPercent] = useState<number>(1);
  const [entryPrice, setEntryPrice] = useState<number>(0);
  const [stopLoss, setStopLoss] = useState<number>(0);
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [direction, setDirection] = useState<Direction>('long');
  const [leverage, setLeverage] = useState<number>(1);

  const takeProfitNum = takeProfit !== '' ? parseFloat(takeProfit) : null;

  const calculations = useMemo(() => {
    const slDistance = Math.abs(entryPrice - stopLoss);

    // Guard against division by zero and invalid inputs
    if (
      entryPrice <= 0 ||
      stopLoss <= 0 ||
      accountBalance <= 0 ||
      riskPercent <= 0 ||
      slDistance === 0 ||
      leverage <= 0
    ) {
      return {
        riskAmount: 0,
        slDistancePercent: 0,
        positionSize: 0,
        positionValue: 0,
        marginRequired: 0,
        maxLoss: 0,
        potentialProfit: null as number | null,
        rrRatio: null as number | null,
        liquidationPrice: null as number | null,
        valid: false,
      };
    }

    const riskAmount = (accountBalance * riskPercent) / 100;
    const slDistancePercent = (slDistance / entryPrice) * 100;
    // Position size is determined by risk, not leverage.
    // Leverage only affects the margin (collateral) required.
    const positionSize = riskAmount / slDistance;
    const positionValue = positionSize * entryPrice;
    const marginRequired = positionValue / leverage;
    const maxLoss = riskAmount;

    let potentialProfit: number | null = null;
    let rrRatio: number | null = null;

    if (takeProfitNum !== null && takeProfitNum > 0) {
      potentialProfit = Math.abs(takeProfitNum - entryPrice) * positionSize;
      rrRatio = riskAmount > 0 ? potentialProfit / riskAmount : null;
    }

    let liquidationPrice: number | null = null;
    if (leverage > 1) {
      if (direction === 'long') {
        liquidationPrice = entryPrice * (1 - 1 / leverage);
      } else {
        liquidationPrice = entryPrice * (1 + 1 / leverage);
      }
    }

    return {
      riskAmount,
      slDistancePercent,
      positionSize,
      positionValue,
      marginRequired,
      maxLoss,
      potentialProfit,
      rrRatio,
      liquidationPrice,
      valid: true,
    };
  }, [accountBalance, riskPercent, entryPrice, stopLoss, takeProfitNum, direction, leverage]);

  // Risk:Reward bar widths
  const rrBarWidths = useMemo(() => {
    if (
      calculations.rrRatio === null ||
      calculations.rrRatio <= 0 ||
      !calculations.valid
    ) {
      return { loss: 50, profit: 50 };
    }
    const total = 1 + calculations.rrRatio;
    const lossPct = (1 / total) * 100;
    const profitPct = (calculations.rrRatio / total) * 100;
    return { loss: lossPct, profit: profitPct };
  }, [calculations.rrRatio, calculations.valid]);

  function fmt(n: number, decimals = 2): string {
    if (!isFinite(n) || isNaN(n)) return '0.00';
    return n.toFixed(decimals);
  }

  function fmtUnits(n: number): string {
    if (!isFinite(n) || isNaN(n)) return '0';
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.0001) return n.toFixed(6);
    return n.toFixed(8);
  }

  return (
    <div className="page-container animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">Risk Calculator</h1>
          <p style={{ color: 'var(--text-secondary)', marginTop: 4, fontSize: '0.9rem' }}>
            Calculate optimal position sizes based on your risk tolerance
          </p>
        </div>
      </div>

      <div className="calc-layout">
        {/* ---- Left: Input Form ---- */}
        <div className="glass-card calc-form">
          <h2 className="calc-form-title">Position Parameters</h2>

          <div className="calc-form-grid">
            {/* Account Balance */}
            <div className="input-group">
              <label className="input-label">Account Balance ($)</label>
              <input
                className="input"
                type="number"
                min={0}
                value={accountBalance}
                onChange={(e) => setAccountBalance(parseFloat(e.target.value) || 0)}
              />
            </div>

            {/* Risk Per Trade */}
            <div className="input-group">
              <label className="input-label">Risk Per Trade (%)</label>
              <input
                className="input"
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={riskPercent}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) setRiskPercent(Math.min(10, Math.max(0.1, val)));
                }}
              />
              <div className="calc-presets">
                {RISK_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`calc-preset-btn${riskPercent === preset ? ' active' : ''}`}
                    onClick={() => setRiskPercent(preset)}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            </div>

            {/* Entry Price */}
            <div className="input-group">
              <label className="input-label">Entry Price ($)</label>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                value={entryPrice || ''}
                placeholder="0.00"
                onChange={(e) => setEntryPrice(parseFloat(e.target.value) || 0)}
              />
            </div>

            {/* Stop Loss */}
            <div className="input-group">
              <label className="input-label">Stop Loss Price ($)</label>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                value={stopLoss || ''}
                placeholder="0.00"
                onChange={(e) => setStopLoss(parseFloat(e.target.value) || 0)}
              />
            </div>

            {/* Take Profit */}
            <div className="input-group">
              <label className="input-label">Take Profit Price ($) — optional</label>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                value={takeProfit}
                placeholder="0.00"
                onChange={(e) => setTakeProfit(e.target.value)}
              />
            </div>

            {/* Leverage */}
            <div className="input-group">
              <label className="input-label">Leverage</label>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                value={leverage}
                onChange={(e) => setLeverage(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </div>

            {/* Direction */}
            <div className="input-group calc-form-full">
              <label className="input-label">Direction</label>
              <div className="calc-direction-toggle">
                <button
                  type="button"
                  className={`calc-direction-btn${direction === 'long' ? ' active-long' : ''}`}
                  onClick={() => setDirection('long')}
                >
                  Long
                </button>
                <button
                  type="button"
                  className={`calc-direction-btn${direction === 'short' ? ' active-short' : ''}`}
                  onClick={() => setDirection('short')}
                >
                  Short
                </button>
              </div>
              {entryPrice > 0 && stopLoss > 0 && (
                (direction === 'long' && stopLoss >= entryPrice) ||
                (direction === 'short' && stopLoss <= entryPrice)
              ) && (
                <p className="calc-sl-warning">
                  Stop Loss should be {direction === 'long' ? 'below' : 'above'} entry price for a {direction} position.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ---- Right: Results ---- */}
        <div>
          {/* 2x2 stat cards */}
          <div className="calc-results-grid">
            <StatCard
              label="Position Size"
              value={calculations.valid ? fmtUnits(calculations.positionSize) : '—'}
              suffix=" units"
            />
            <StatCard
              label="Position Value"
              value={calculations.valid ? fmt(calculations.positionValue) : '—'}
              prefix="$"
            />
            {leverage > 1 && (
              <StatCard
                label="Margin Required"
                value={calculations.valid ? fmt(calculations.marginRequired) : '—'}
                prefix="$"
              />
            )}
            <StatCard
              label="Max Loss"
              value={calculations.valid ? fmt(calculations.maxLoss) : '—'}
              prefix="$"
              variant="loss"
            />
            <StatCard
              label="Potential Profit"
              value={
                calculations.valid && calculations.potentialProfit !== null
                  ? fmt(calculations.potentialProfit)
                  : '—'
              }
              prefix={calculations.potentialProfit !== null ? '$' : ''}
              variant={calculations.potentialProfit !== null ? 'profit' : 'default'}
            />
          </div>

          {/* Risk:Reward visualization */}
          <div className="glass-card calc-rr-bar">
            <div className="calc-rr-header">
              <span style={{ color: 'var(--loss)' }}>
                Risk: ${calculations.valid ? fmt(calculations.maxLoss) : '0.00'}
              </span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {calculations.rrRatio !== null
                  ? `1 : ${fmt(calculations.rrRatio)}`
                  : 'Risk : Reward'}
              </span>
              <span style={{ color: 'var(--profit)' }}>
                Reward: $
                {calculations.valid && calculations.potentialProfit !== null
                  ? fmt(calculations.potentialProfit)
                  : '0.00'}
              </span>
            </div>
            <div className="calc-rr-track">
              <div
                className="calc-rr-loss"
                style={{ width: `${rrBarWidths.loss}%` }}
              />
              <div
                className="calc-rr-profit"
                style={{ width: `${rrBarWidths.profit}%` }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 8,
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
              }}
            >
              <span>SL Distance: {calculations.valid ? fmt(calculations.slDistancePercent) : '0.00'}%</span>
              <span>Risk Amount: ${calculations.valid ? fmt(calculations.riskAmount) : '0.00'}</span>
            </div>
          </div>

          {/* Liquidation Price warning */}
          {leverage > 1 && calculations.valid && calculations.liquidationPrice !== null && (
            <div className="calc-liquidation">
              <div className="calc-liquidation-title">
                Liquidation Price ({direction === 'long' ? 'Long' : 'Short'} {leverage}x)
              </div>
              <div className="calc-liquidation-value">
                ${fmt(calculations.liquidationPrice)}
              </div>
              <p
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  marginTop: 6,
                  lineHeight: 1.4,
                }}
              >
                Your position will be liquidated if the price reaches this level.
                This is an estimate and does not account for fees or funding rates.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
