"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLiveCandles, LiveTimeframe } from "@/hooks/useLiveCandles";
import {
  analyzeCandles,
  SignalSnapshot,
  hasActionChanged,
} from "@/utils/signalEngine";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
] as const;
const TIMEFRAMES: LiveTimeframe[] = ["1m", "5m", "15m", "1h"];
const MAX_HISTORY_SIGNALS = 20;

function formatPrice(p: number): string {
  if (p >= 100)
    return p.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (p >= 1)
    return p.toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });
  return p.toLocaleString("en-US", {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function LivePage() {
  const [symbol, setSymbol] = useState<string>("BTCUSDT");
  const [timeframe, setTimeframe] = useState<LiveTimeframe>("5m");
  const [signalHistory, setSignalHistory] = useState<SignalSnapshot[]>([]);
  const lastEmittedRef = useRef<SignalSnapshot | null>(null);

  const { candles, status, error } = useLiveCandles({
    symbol,
    timeframe,
    history: 200,
  });

  const snapshot = useMemo<SignalSnapshot | null>(() => {
    if (candles.length === 0) return null;
    return analyzeCandles(candles);
  }, [candles]);

  useEffect(() => {
    if (!snapshot) return;
    if (hasActionChanged(lastEmittedRef.current, snapshot)) {
      lastEmittedRef.current = snapshot;
      setSignalHistory((prev) =>
        [snapshot, ...prev].slice(0, MAX_HISTORY_SIGNALS),
      );
    }
  }, [snapshot]);

  // Clear history on symbol/timeframe change
  useEffect(() => {
    setSignalHistory([]);
    lastEmittedRef.current = null;
  }, [symbol, timeframe]);

  const chartData = useMemo(
    () =>
      candles.slice(-120).map((c) => ({
        time: formatTime(c.closeTime),
        price: c.close,
      })),
    [candles],
  );

  const priceNow =
    candles.length > 0 ? candles[candles.length - 1].close : null;
  const priceChange =
    candles.length > 1
      ? ((candles[candles.length - 1].close - candles[0].close) /
          candles[0].close) *
        100
      : 0;

  const actionLabel = snapshot
    ? snapshot.action === "long"
      ? "BUY"
      : snapshot.action === "short"
        ? "SELL"
        : "HOLD"
    : "…";

  const actionClass = snapshot
    ? snapshot.action === "long"
      ? "live-action long"
      : snapshot.action === "short"
        ? "live-action short"
        : "live-action flat"
    : "live-action flat";

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Live Signals</h1>
          <p className="page-subtitle">
            Rule-based technical-analysis feed — EMA 9/21 + RSI + MACD
          </p>
        </div>
      </div>

      <div className="live-disclaimer" role="alert">
        <strong>Educational only, not financial advice.</strong> These signals
        are generated from generic technical indicators and do not account for
        your risk tolerance, position sizing, or market context. Trading is
        risky; you can lose money.
      </div>

      <div className="live-controls">
        <label className="live-control-group">
          <span>Symbol</span>
          <select
            className="input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            aria-label="Trading pair"
          >
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="live-control-group" role="group" aria-label="Timeframe">
          <span>Timeframe</span>
          <div className="live-tf-buttons">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                className={`trades-direction-btn ${timeframe === tf ? "active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="live-status" aria-live="polite">
          <span className={`live-status-dot live-status-${status}`} />
          <span>
            {status === "loading" && "Loading history…"}
            {status === "connected" && "Live"}
            {status === "closed" && "Disconnected"}
            {status === "error" && (error || "Error")}
            {status === "idle" && "Idle"}
          </span>
        </div>
      </div>

      <div className="live-grid">
        <div className="glass-card live-signal-card">
          <div className="live-signal-header">
            <span className="live-signal-label">Current Signal</span>
            <span className={actionClass}>{actionLabel}</span>
          </div>
          {snapshot && (
            <>
              <div className="live-signal-strength">
                <span className="live-signal-strength-label">
                  Strength {snapshot.strength}/10
                </span>
                <div className="live-strength-bar">
                  <div
                    className={`live-strength-fill ${snapshot.action}`}
                    style={{ width: `${(snapshot.strength / 10) * 100}%` }}
                  />
                </div>
              </div>
              <ul className="live-reasons">
                {snapshot.reasons.length > 0 ? (
                  snapshot.reasons.map((reason, i) => <li key={i}>{reason}</li>)
                ) : (
                  <li>No dominant signal — market is indecisive.</li>
                )}
              </ul>
              <div className="live-indicators-grid">
                <IndicatorCell
                  label="Price"
                  value={priceNow !== null ? formatPrice(priceNow) : "—"}
                />
                <IndicatorCell
                  label="Session Δ"
                  value={`${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`}
                />
                <IndicatorCell
                  label="EMA 9"
                  value={fmtInd(snapshot.indicators.emaFast)}
                />
                <IndicatorCell
                  label="EMA 21"
                  value={fmtInd(snapshot.indicators.emaSlow)}
                />
                <IndicatorCell
                  label="RSI"
                  value={fmtNum(snapshot.indicators.rsi, 1)}
                />
                <IndicatorCell
                  label="MACD Hist"
                  value={fmtNum(snapshot.indicators.macdHist, 4)}
                />
              </div>
            </>
          )}
          {!snapshot && candles.length === 0 && <p>Waiting for market data…</p>}
          {!snapshot && candles.length > 0 && (
            <p>Not enough candles yet to analyze.</p>
          )}
        </div>

        <div className="glass-card live-chart-card">
          <h3 className="dashboard-section-title">
            {symbol} — {timeframe}
          </h3>
          <div style={{ width: "100%", height: 300 }}>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="price-area" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4f8cff" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#4f8cff" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.05)"
                  />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    minTickGap={40}
                  />
                  <YAxis
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--surface-elevated, #1c1f26)",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke="#4f8cff"
                    strokeWidth={2}
                    fill="url(#price-area)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  color: "var(--text-secondary)",
                }}
              >
                Loading chart…
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card live-history-card">
        <h3 className="dashboard-section-title">Signal History</h3>
        {signalHistory.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            No signal changes yet. New entries appear here whenever the current
            signal flips.
          </p>
        ) : (
          <table className="live-history-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Price</th>
                <th>Strength</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {signalHistory.map((s) => (
                <tr key={`${s.time}-${s.action}`}>
                  <td>{formatTime(s.time)}</td>
                  <td>
                    <span className={`live-action-chip ${s.action}`}>
                      {s.action === "long"
                        ? "BUY"
                        : s.action === "short"
                          ? "SELL"
                          : "HOLD"}
                    </span>
                  </td>
                  <td>{formatPrice(s.price)}</td>
                  <td>{s.strength}/10</td>
                  <td className="live-history-reasons">
                    {s.reasons.slice(0, 2).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function IndicatorCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="live-indicator-cell">
      <span className="live-indicator-label">{label}</span>
      <span className="live-indicator-value">{value}</span>
    </div>
  );
}

function fmtInd(v: number | null): string {
  if (v === null) return "—";
  return formatPrice(v);
}

function fmtNum(v: number | null, digits: number): string {
  if (v === null) return "—";
  return v.toFixed(digits);
}
