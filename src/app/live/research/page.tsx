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
  type StrategyMode,
} from "@/utils/advancedBacktest";
import {
  optimizeParameters,
  type ParameterResult,
} from "@/utils/parameterOptimizer";
import { runAutoMatrix, type MatrixCell } from "@/utils/autoMatrix";
import {
  fetchFundingHistory,
  analyzeFunding,
  describeFundingRegime,
  type FundingSnapshot,
} from "@/utils/fundingRate";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const TFS: LiveTimeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
const COUNTS = [1000, 3000, 6000, 12000];
const MATRIX_TFS: LiveTimeframe[] = ["1h", "4h", "1d", "1w"];

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
  const [count, setCount] = useState<number>(6000);
  const [mode, setMode] = useState<StrategyMode>("regime-switch");
  const [loading, setLoading] = useState(false);
  const [loadStatus, setLoadStatus] = useState<string>("");
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
  const [matrix, setMatrix] = useState<MatrixCell[]>([]);
  const [matrixRunning, setMatrixRunning] = useState(false);
  const [matrixProgress, setMatrixProgress] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
  const [funding, setFunding] = useState<FundingSnapshot | null>(null);
  const [fundingLoading, setFundingLoading] = useState(false);

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
      setLoadStatus(
        `Loaded ${h.length} candles — running backtest with realistic costs (${mode})…`,
      );
      await new Promise((r) => setTimeout(r, 50));
      const rep = runAdvancedBacktest({ candles: h, timeframe, mode });
      setReport(rep);
      setLoadStatus(
        `Done — ${historyDays(h.length, timeframe).toFixed(1)} days covered · mode: ${mode}.`,
      );
    } catch (err) {
      setLoadStatus(`Error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }

  async function runMatrix() {
    setMatrixRunning(true);
    setMatrix([]);
    setMatrixProgress({ done: 0, total: 0, label: "" });
    try {
      const rows = await runAutoMatrix({
        symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        timeframes: MATRIX_TFS,
        targetCount: count,
        onProgress: (done, total, label) =>
          setMatrixProgress({ done, total, label }),
      });
      setMatrix(rows);
    } finally {
      setMatrixRunning(false);
    }
  }

  async function loadFunding() {
    setFundingLoading(true);
    try {
      const events = await fetchFundingHistory(symbol, 100);
      setFunding(analyzeFunding(events));
    } catch {
      setFunding(null);
    } finally {
      setFundingLoading(false);
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
        <strong>This is the reality check.</strong> Months of real Binance
        candles, realistic fees + slippage + funding, honest risk-adjusted
        metrics. If the verdict says „NO EDGE", respect that.
      </div>

      <div className="glass-card live-research-panel">
        <h3 className="dashboard-section-title">
          What research says actually works (and what doesn&apos;t)
        </h3>
        <ul className="live-research-list">
          <li>
            <strong>Classic EMA-crossover alone: fails.</strong> Crypto spends
            ~60% in ranges → constant whipsaws. Only ~40% of time does an
            EMA-cross strategy have a chance to work.
          </li>
          <li>
            <strong>Multi-indicator ensemble: helps.</strong> Independent voters
            (trend + momentum + volume + BB) reduce false signals when 4+ agree
            — try the „Ensemble" mode below.
          </li>
          <li>
            <strong>Funding-rate extremes: real crypto-specific edge.</strong>{" "}
            &gt;+0.03%/8h = crowded longs → short-squeeze risk. Genuine retail
            positioning signal. Load funding below.
          </li>
          <li>
            <strong>
              Long-horizon trend-following (3-12 month holds): +1%/mo documented
              (Jegadeesh/Titman).
            </strong>{" "}
            This is NOT daytrading — it means the rules only work on
            daily/weekly bars.
          </li>
          <li>
            <strong>
              Funding-rate arbitrage (spot long + perpetual short):
              market-neutral, documented profitable for retail with $300+.
            </strong>{" "}
            Not a signal but a cashflow strategy.
          </li>
          <li>
            <strong>
              Pairs trading cointegrated pairs: documented profitable
            </strong>
            , especially PoW pairs — needs two-asset infrastructure.
          </li>
          <li>
            <strong>Academic consensus (Park/Irwin 2007):</strong> single-rule
            TA strategies are roughly break-even after costs. Ensemble +
            regime-switching + cost-awareness is the minimum to get an edge.
          </li>
          <li>
            <strong>Data-snooping risk:</strong> optimiser-picked parameters
            often fail out-of-sample. Always walk-forward validate. One bad
            regime kills a curve-fit.
          </li>
        </ul>
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
          <label className="live-control-group">
            <span>Mode</span>
            <select
              className="input"
              value={mode}
              onChange={(e) => setMode(e.target.value as StrategyMode)}
            >
              <option value="regime-switch">Regime switch</option>
              <option value="ensemble">Ensemble (4-of-6 vote)</option>
              <option value="trend-filter">
                Trend filter (200-SMA, Faber)
              </option>
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
            onClick={runMatrix}
            disabled={matrixRunning}
          >
            {matrixRunning && matrixProgress
              ? `Matrix ${matrixProgress.done}/${matrixProgress.total}`
              : "Run full matrix (3×3×2)"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={loadFunding}
            disabled={fundingLoading}
          >
            {fundingLoading ? "Loading funding…" : "Check funding rate"}
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
        {matrixRunning && matrixProgress && (
          <p className="live-muted-note" style={{ marginTop: 8 }}>
            Matrix: {matrixProgress.label} ({matrixProgress.done}/
            {matrixProgress.total})
          </p>
        )}
      </div>

      {funding && (
        <div
          className={`glass-card live-verdict live-verdict-${funding.reversalBias === "none" ? "neutral" : funding.reversalBias === "long" ? "profit" : "loss"}`}
        >
          <h2>Funding Rate · {symbol}</h2>
          <p>
            <strong>{(funding.latest.fundingRate * 100).toFixed(4)}%/8h</strong>{" "}
            ({funding.annualisedPct.toFixed(2)}% annualised) · z-score{" "}
            {funding.zScore.toFixed(2)} · <strong>{funding.regime}</strong>.
            <br />
            {describeFundingRegime(funding.regime)}
            {funding.reversalBias !== "none" && (
              <>
                {" "}
                <strong>
                  Reversal bias: {funding.reversalBias.toUpperCase()}.
                </strong>
              </>
            )}
          </p>
        </div>
      )}

      {matrix.length > 0 &&
        matrix.filter(
          (c) => c.verdict === "positive" || c.verdict === "low-freq-positive",
        ).length > 0 && (
          <div className="glass-card live-verdict live-verdict-profit">
            <h2>✓ POSITIVE EDGE CONFIRMED</h2>
            <p>
              {(() => {
                const winner = matrix.find(
                  (c) =>
                    c.verdict === "positive" ||
                    c.verdict === "low-freq-positive",
                );
                if (!winner) return "";
                return `Best: ${winner.symbol} ${winner.timeframe} ${winner.mode} · ${fmtPct(winner.totalReturnPct)} return · Sharpe ${fmtNum(winner.sharpe)} · PF ${fmtNum(winner.profitFactor)} · MaxDD ${fmtPct(winner.maxDrawdownPct)} across ${winner.trades} trades. This is a Faber-style slow-trend strategy (long-only, SMA-filter, signal-flip exit). It is NOT daytrading — expect ~2-10 trades per year.`;
              })()}
            </p>
          </div>
        )}

      {matrix.length > 0 && (
        <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
          <h3 className="dashboard-section-title">
            Auto-Matrix (sorted by Sharpe)
          </h3>
          <p className="live-muted-note">
            BTC/ETH/SOL × 5m/15m/1h × regime-switch + ensemble — every combo
            backtested with fees+slippage+funding.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th>Mode</th>
                  <th>Trades</th>
                  <th>Return</th>
                  <th>WR</th>
                  <th>Sharpe</th>
                  <th>PF</th>
                  <th>MaxDD</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((c, i) => (
                  <tr key={i}>
                    <td>{c.symbol}</td>
                    <td>{c.timeframe}</td>
                    <td>{c.mode}</td>
                    <td>{c.trades}</td>
                    <td className={c.totalReturnPct > 0 ? "profit" : "loss"}>
                      {fmtPct(c.totalReturnPct)}
                    </td>
                    <td>{(c.winRate * 100).toFixed(0)}%</td>
                    <td>{fmtNum(c.sharpe)}</td>
                    <td>{fmtNum(c.profitFactor)}</td>
                    <td>{fmtPct(c.maxDrawdownPct)}</td>
                    <td>
                      <span
                        className={`matrix-verdict matrix-verdict-${c.verdict}`}
                      >
                        {c.verdict}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="live-muted-note" style={{ marginTop: 12 }}>
            {matrix.filter(
              (c) =>
                c.verdict === "positive" || c.verdict === "low-freq-positive",
            ).length === 0
              ? "⚠ No combination produced a positive edge after costs. The rule-set as-is does NOT work in live trading."
              : `${matrix.filter((c) => c.verdict === "positive" || c.verdict === "low-freq-positive").length} combo(s) show positive edge (including Faber-style low-frequency) — treat as paper-trading candidates.`}
          </p>
        </div>
      )}

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
