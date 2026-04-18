"use client";

import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { loadBinanceHistory, historyDays } from "@/utils/historicalData";
import {
  runAdvancedBacktest,
  type BacktestReport,
} from "@/utils/advancedBacktest";
import {
  optimizeParameters,
  type ParameterResult,
} from "@/utils/parameterOptimizer";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const TFS: LiveTimeframe[] = ["5m", "15m", "1h"];
const COUNTS = [1000, 3000, 6000, 12000];

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function fmtNum(v: number, digits = 2): string {
  if (!isFinite(v)) return "∞";
  return v.toFixed(digits);
}

function verdict(r: BacktestReport): {
  label: string;
  tone: "profit" | "loss" | "neutral";
  text: string;
} {
  const { metrics } = r;
  if (metrics.trades < 20) {
    return {
      label: "INCONCLUSIVE",
      tone: "neutral",
      text: `Only ${metrics.trades} trades in this sample — too few to conclude anything. Load more history or a different timeframe.`,
    };
  }
  if (
    metrics.totalReturnPct > 0 &&
    metrics.profitFactor > 1.3 &&
    metrics.sharpe > 0.8 &&
    metrics.maxDrawdownPct < 0.3
  ) {
    return {
      label: "POSITIVE EDGE (AFTER COSTS)",
      tone: "profit",
      text: `${metrics.trades} trades · return ${fmtPct(metrics.totalReturnPct)} · Sharpe ${fmtNum(metrics.sharpe)} · PF ${fmtNum(metrics.profitFactor)} · MaxDD ${fmtPct(metrics.maxDrawdownPct)}. Still: past performance ≠ future results. Paper-trade before risking real money.`,
    };
  }
  if (metrics.totalReturnPct > 0 && metrics.profitFactor > 1) {
    return {
      label: "MARGINAL",
      tone: "neutral",
      text: `${metrics.trades} trades, slightly positive (${fmtPct(metrics.totalReturnPct)}, PF ${fmtNum(metrics.profitFactor)}, Sharpe ${fmtNum(metrics.sharpe)}). Edge is too thin to trade with confidence — one bad regime kills it.`,
    };
  }
  return {
    label: "NO EDGE",
    tone: "loss",
    text: `${metrics.trades} trades · return ${fmtPct(metrics.totalReturnPct)} · PF ${fmtNum(metrics.profitFactor)} · Sharpe ${fmtNum(metrics.sharpe)}. After fees+slippage the rules do NOT work on this window. Do not trade live.`,
  };
}

export default function ResearchPage() {
  const [symbol, setSymbol] = useState<string>("BTCUSDT");
  const [timeframe, setTimeframe] = useState<LiveTimeframe>("15m");
  const [count, setCount] = useState<number>(3000);
  const [loading, setLoading] = useState(false);
  const [loadStatus, setLoadStatus] = useState<string>("");
  const [candleCount, setCandleCount] = useState<number>(0);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [optResults, setOptResults] = useState<ParameterResult[]>([]);
  const [optimising, setOptimising] = useState(false);
  const [optProgress, setOptProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [candles, setCandles] = useState<
    Awaited<ReturnType<typeof loadBinanceHistory>>
  >([]);

  async function loadAndRun() {
    setLoading(true);
    setLoadStatus("Fetching history…");
    setReport(null);
    setOptResults([]);
    try {
      const h = await loadBinanceHistory({
        symbol,
        timeframe,
        targetCount: count,
      });
      setCandles(h);
      setCandleCount(h.length);
      setLoadStatus(
        `Loaded ${h.length} candles — running backtest with realistic costs…`,
      );
      // Yield so the status paints
      await new Promise((r) => setTimeout(r, 50));
      const rep = runAdvancedBacktest({ candles: h, timeframe });
      setReport(rep);
      setLoadStatus(
        `Done — ${historyDays(h.length, timeframe).toFixed(1)} days covered.`,
      );
    } catch (err) {
      setLoadStatus(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }

  async function runOptimiser() {
    if (candles.length < 500) return;
    setOptimising(true);
    setOptResults([]);
    setOptProgress({ done: 0, total: 0 });
    try {
      const res = await optimizeParameters({
        candles,
        timeframe,
        onProgress: (done, total) => setOptProgress({ done, total }),
      });
      setOptResults(res.slice(0, 10));
    } finally {
      setOptimising(false);
    }
  }

  const equityChart = report
    ? report.metrics.equityCurve.map((v, i) => ({ i, equity: (v - 1) * 100 }))
    : [];

  const v = report ? verdict(report) : null;

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Strategy Research</h1>
          <p className="page-subtitle">
            Long-history backtest · realistic costs · regime-switching ·
            walk-forward optimisation
          </p>
        </div>
      </div>

      <div className="live-disclaimer" role="alert">
        <strong>This is the reality check.</strong> We load months of real
        Binance candles, replay the strategy with Binance-Futures fees +
        slippage + funding, and report honest risk-adjusted metrics. If the
        verdict says „NO EDGE", respect that.
      </div>

      <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          <label className="live-control-group">
            <span>Symbol</span>
            <select
              className="input"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            >
              {SYMBOLS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="live-control-group">
            <span>Timeframe</span>
            <select
              className="input"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value as LiveTimeframe)}
            >
              {TFS.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>
          <label className="live-control-group">
            <span>Candles</span>
            <select
              className="input"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {COUNTS.map((c) => (
                <option key={c} value={c}>
                  {c} (≈{historyDays(c, timeframe).toFixed(0)}d)
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            onClick={loadAndRun}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load & run backtest"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runOptimiser}
            disabled={optimising || candles.length < 500}
          >
            {optimising && optProgress
              ? `Optimising ${optProgress.done}/${optProgress.total}`
              : "Optimise parameters"}
          </button>
        </div>
        {loadStatus && (
          <p className="live-muted-note" style={{ marginTop: 12 }}>
            {loadStatus}
          </p>
        )}
      </div>

      {report && v && (
        <>
          <div className={`glass-card live-verdict live-verdict-${v.tone}`}>
            <h2>{v.label}</h2>
            <p>{v.text}</p>
          </div>

          <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
            <h3 className="dashboard-section-title">Backtest Metrics</h3>
            <div className="live-backtest-stats">
              <Stat label="Trades" value={String(report.metrics.trades)} />
              <Stat
                label="Total Return"
                value={fmtPct(report.metrics.totalReturnPct)}
                tone={report.metrics.totalReturnPct > 0 ? "profit" : "loss"}
              />
              <Stat
                label="Win Rate"
                value={`${(report.metrics.winRate * 100).toFixed(1)}%`}
              />
              <Stat
                label="Profit Factor"
                value={fmtNum(report.metrics.profitFactor)}
                tone={report.metrics.profitFactor > 1 ? "profit" : "loss"}
              />
              <Stat
                label="Sharpe"
                value={fmtNum(report.metrics.sharpe)}
                tone={
                  report.metrics.sharpe > 1
                    ? "profit"
                    : report.metrics.sharpe < 0
                      ? "loss"
                      : undefined
                }
              />
              <Stat label="Sortino" value={fmtNum(report.metrics.sortino)} />
              <Stat
                label="Max DD"
                value={fmtPct(report.metrics.maxDrawdownPct)}
                tone="loss"
              />
              <Stat label="Calmar" value={fmtNum(report.metrics.calmar)} />
              <Stat
                label="Expectancy"
                value={`${fmtNum(report.metrics.expectancyR)} R`}
                tone={report.metrics.expectancyR > 0 ? "profit" : "loss"}
              />
            </div>
          </div>

          {equityChart.length > 1 && (
            <div
              className="glass-card"
              style={{ padding: 20, marginBottom: 20 }}
            >
              <h3 className="dashboard-section-title">
                Equity Curve (after costs)
              </h3>
              <div style={{ width: "100%", height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={equityChart}>
                    <defs>
                      <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor="#4f8cff"
                          stopOpacity={0.35}
                        />
                        <stop
                          offset="100%"
                          stopColor="#4f8cff"
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="rgba(255,255,255,0.05)"
                    />
                    <XAxis
                      dataKey="i"
                      tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                      tickFormatter={(v) => `${v.toFixed(0)}%`}
                      width={70}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface-elevated, #1c1f26)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v) =>
                        typeof v === "number" ? `${v.toFixed(2)}%` : String(v)
                      }
                    />
                    <Area
                      type="monotone"
                      dataKey="equity"
                      stroke="#4f8cff"
                      strokeWidth={2}
                      fill="url(#eq)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
            <h3 className="dashboard-section-title">Strategy Breakdown</h3>
            <StrategyBreakdown trades={report.trades} />
          </div>

          {optResults.length > 0 && (
            <div
              className="glass-card"
              style={{ padding: 20, marginBottom: 20 }}
            >
              <h3 className="dashboard-section-title">
                Parameter Optimiser — Top 10 (walk-forward)
              </h3>
              <p className="live-muted-note">
                Trained on first 70% of candles, scored on unseen 30%. Score
                penalises big IS-vs-OOS gaps (overfit).
              </p>
              <div style={{ overflowX: "auto" }}>
                <table className="live-history-table">
                  <thead>
                    <tr>
                      <th>EMA F/S</th>
                      <th>ADX</th>
                      <th>SL/TP ATR</th>
                      <th>IS Return</th>
                      <th>OOS Return</th>
                      <th>OOS Sharpe</th>
                      <th>OOS PF</th>
                      <th>OOS MaxDD</th>
                      <th>Stable?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optResults.map((r, i) => (
                      <tr key={i}>
                        <td>
                          {r.config.emaFast}/{r.config.emaSlow}
                        </td>
                        <td>{r.config.adxTrendThreshold}</td>
                        <td>
                          {r.config.stopAtrMult}/{r.config.targetAtrMult}
                        </td>
                        <td>{fmtPct(r.is.totalReturnPct)}</td>
                        <td>{fmtPct(r.oos.totalReturnPct)}</td>
                        <td>{fmtNum(r.oos.sharpe)}</td>
                        <td>{fmtNum(r.oos.profitFactor)}</td>
                        <td>{fmtPct(r.oos.maxDrawdownPct)}</td>
                        <td>{r.stable ? "✓" : "✗"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "profit" | "loss";
}) {
  return (
    <div className="live-indicator-cell">
      <span className="live-indicator-label">{label}</span>
      <span className={`live-indicator-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

function StrategyBreakdown({ trades }: { trades: BacktestReport["trades"] }) {
  const byStrat: Record<string, { n: number; wins: number; totalPct: number }> =
    {};
  for (const t of trades) {
    if (!byStrat[t.strategy])
      byStrat[t.strategy] = { n: 0, wins: 0, totalPct: 0 };
    byStrat[t.strategy].n++;
    if (t.netPnlPct > 0) byStrat[t.strategy].wins++;
    byStrat[t.strategy].totalPct += t.netPnlPct;
  }
  const entries = Object.entries(byStrat);
  if (entries.length === 0)
    return <p style={{ color: "var(--text-secondary)" }}>No trades.</p>;
  return (
    <div className="live-backtest-stats">
      {entries.map(([name, s]) => (
        <div key={name} className="live-indicator-cell">
          <span className="live-indicator-label">{name}</span>
          <span className="live-indicator-value">
            {s.n} trades · {((s.wins / s.n) * 100).toFixed(0)}% WR ·{" "}
            {fmtPct(s.totalPct)}
          </span>
        </div>
      ))}
    </div>
  );
}
