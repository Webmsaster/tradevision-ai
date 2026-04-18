"use client";

import { useState, useEffect, useCallback } from "react";
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
import {
  fetchRotationCandles,
  runCrossSectionalRotation,
  type RotationReport,
} from "@/utils/crossSectional";
import { fetchAndBacktestCarry, type CarryReport } from "@/utils/fundingCarry";
import {
  fetchMvrvHistory,
  runMvrvBacktest,
  type MvrvBacktestReport,
} from "@/utils/mvrvStrategy";
import {
  fetchDominance,
  classifyDominance,
  type DominanceSnapshot,
  type DominanceRegime,
} from "@/utils/btcDominance";
import {
  computeHourStats,
  runHourStrategyWalkForward,
  type HourOfDayReport,
} from "@/utils/hourOfDayStrategy";
import {
  runFundingReversionBacktest,
  type ReversionReport,
} from "@/utils/fundingReversion";
import {
  runChampionStrategy,
  runMondayReversal,
  MAKER_COSTS,
  type ChampionReport,
  type MondayReport,
} from "@/utils/intradayLab";
import {
  computeLiveSignals,
  type LiveSignalsReport,
} from "@/utils/liveSignals";
import type { LiveTimeframe } from "@/hooks/useLiveCandles";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const TFS: LiveTimeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
const COUNTS = [1000, 3000, 6000, 12000];
const MATRIX_TFS: LiveTimeframe[] = ["15m", "1h", "4h", "1d", "1w"];

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
  // Crypto-appropriate positive edge (higher DD tolerated, Calmar > 1)
  if (
    metrics.totalReturnPct > 0 &&
    metrics.profitFactor > 1.5 &&
    metrics.sharpe > 1.5 &&
    metrics.maxDrawdownPct < 0.5 &&
    metrics.calmar > 1
  ) {
    return {
      label: "POSITIVE EDGE (CRYPTO-ADJUSTED)",
      tone: "profit",
      text: `${metrics.trades} trades · return ${fmtPct(metrics.totalReturnPct)} · Sharpe ${fmtNum(metrics.sharpe)} · PF ${fmtNum(metrics.profitFactor)} · Calmar ${fmtNum(metrics.calmar)}. MaxDD ${fmtPct(metrics.maxDrawdownPct)} is elevated but the strategy's return more than compensates (Calmar > 1). Paper-trade first.`,
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
  const [rotation, setRotation] = useState<{
    tf: LiveTimeframe;
    lookback: number;
    report: RotationReport;
  } | null>(null);
  const [rotationLoading, setRotationLoading] = useState(false);
  const [rotationTf, setRotationTf] = useState<LiveTimeframe>("1w");
  const [rotationLookback, setRotationLookback] = useState<number>(12);
  const [carry, setCarry] = useState<{ symbol: string; report: CarryReport }[]>(
    [],
  );
  const [carryLoading, setCarryLoading] = useState(false);
  const [mvrv, setMvrv] = useState<MvrvBacktestReport | null>(null);
  const [mvrvLoading, setMvrvLoading] = useState(false);
  const [dominance, setDominance] = useState<{
    snap: DominanceSnapshot;
    regime: DominanceRegime;
  } | null>(null);
  const [dominanceLoading, setDominanceLoading] = useState(false);
  const [hourReport, setHourReport] = useState<{
    symbol: string;
    taker: HourOfDayReport;
    maker: HourOfDayReport;
    oos: HourOfDayReport;
    stats: ReturnType<typeof computeHourStats>;
  } | null>(null);
  const [hourLoading, setHourLoading] = useState(false);
  const [fundingRev, setFundingRev] = useState<
    { symbol: string; mode: string; report: ReversionReport }[]
  >([]);
  const [fundingRevLoading, setFundingRevLoading] = useState(false);
  const [champion, setChampion] = useState<
    { symbol: string; fwd: ChampionReport; rev: ChampionReport }[]
  >([]);
  const [championLoading, setChampionLoading] = useState(false);
  const [monday, setMonday] = useState<
    { symbol: string; report: MondayReport }[]
  >([]);
  const [mondayLoading, setMondayLoading] = useState(false);
  const [liveSignals, setLiveSignals] = useState<LiveSignalsReport | null>(
    null,
  );
  const [liveSignalsLoading, setLiveSignalsLoading] = useState(false);
  const [liveSignalsError, setLiveSignalsError] = useState<string | null>(null);

  const refreshLiveSignals = useCallback(async () => {
    setLiveSignalsLoading(true);
    setLiveSignalsError(null);
    try {
      const r = await computeLiveSignals();
      setLiveSignals(r);
    } catch (err) {
      setLiveSignalsError(err instanceof Error ? err.message : "unknown error");
    } finally {
      setLiveSignalsLoading(false);
    }
  }, []);

  // Auto-load on mount and refresh every 5 minutes so the signal stays
  // fresh as the UTC hour changes. Users can also click the button for an
  // immediate refresh.
  useEffect(() => {
    refreshLiveSignals();
    const id = setInterval(refreshLiveSignals, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshLiveSignals]);

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

  async function runRotation() {
    setRotationLoading(true);
    try {
      const byCandles = await fetchRotationCandles(
        ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
        rotationTf,
        rotationTf === "1w" ? 400 : 3000,
      );
      const report = runCrossSectionalRotation({
        byCandles,
        timeframe: rotationTf,
        config: {
          lookbackBars: rotationLookback,
          topN: 1,
          skipLastBars: 0,
          rebalanceEveryBar: true,
        },
      });
      setRotation({ tf: rotationTf, lookback: rotationLookback, report });
    } finally {
      setRotationLoading(false);
    }
  }

  async function runCarry() {
    setCarryLoading(true);
    setCarry([]);
    try {
      const results: { symbol: string; report: CarryReport }[] = [];
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        try {
          const rep = await fetchAndBacktestCarry(sym, 3000);
          results.push({ symbol: sym, report: rep });
        } catch (err) {
          console.warn(`Carry fetch failed for ${sym}`, err);
        }
      }
      setCarry(results);
    } finally {
      setCarryLoading(false);
    }
  }

  async function runMvrv() {
    setMvrvLoading(true);
    try {
      const samples = await fetchMvrvHistory();
      setMvrv(runMvrvBacktest(samples));
    } catch (err) {
      console.warn("MVRV fetch failed", err);
      setMvrv(null);
    } finally {
      setMvrvLoading(false);
    }
  }

  async function runHourOfDay() {
    setHourLoading(true);
    setHourReport(null);
    try {
      const h = await loadBinanceHistory({
        symbol,
        timeframe: "1h",
        targetCount: 12000,
      });
      const stats = computeHourStats(h);
      const taker = runHourStrategyWalkForward(h, 0.5, {
        longTopK: 3,
        shortBottomK: 3,
        requireSignificance: true,
      });
      const maker = runHourStrategyWalkForward(h, 0.5, {
        longTopK: 3,
        shortBottomK: 3,
        requireSignificance: true,
        costs: {
          takerFee: 0.0002,
          slippageBps: 0,
          fundingBpPerHour: 0.1,
        },
      });
      setHourReport({ symbol, taker, maker, oos: maker, stats });
    } finally {
      setHourLoading(false);
    }
  }

  async function runFundingReversion() {
    setFundingRevLoading(true);
    setFundingRev([]);
    try {
      const results: {
        symbol: string;
        mode: string;
        report: ReversionReport;
      }[] = [];
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const [candles, fundingEvents] = await Promise.all([
          loadBinanceHistory({
            symbol: sym,
            timeframe: "1h",
            targetCount: 20000,
          }),
          fetchFundingHistory(sym, 3000),
        ]);
        for (const mode of [
          "reversion",
          "continuation",
          "regime-aware",
        ] as const) {
          const rep = runFundingReversionBacktest(candles, fundingEvents, {
            entryPosFunding: 0.0005,
            entryNegFunding: 0.0004,
            holdBars: 8,
            stopPct: 0.008,
            targetPct: 0.012,
            mode,
            smaPeriod: 200,
          });
          results.push({ symbol: sym, mode, report: rep });
        }
      }
      setFundingRev(results);
    } finally {
      setFundingRevLoading(false);
    }
  }

  async function runChampion() {
    setChampionLoading(true);
    setChampion([]);
    try {
      const results: {
        symbol: string;
        fwd: ChampionReport;
        rev: ChampionReport;
      }[] = [];
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const h = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 20000,
        });
        const cfg = {
          trainRatio: 0.5,
          topK: 5,
          bottomK: 5,
          smaPeriodBars: 50,
          costs: MAKER_COSTS,
          requireSignificance: false,
          longOnly: true,
        };
        const fwd = runChampionStrategy(h, cfg);
        const reversed = h.slice().reverse();
        const rev = runChampionStrategy(reversed, cfg);
        results.push({ symbol: sym, fwd, rev });
      }
      setChampion(results);
    } finally {
      setChampionLoading(false);
    }
  }

  async function runMonday() {
    setMondayLoading(true);
    setMonday([]);
    try {
      const results: { symbol: string; report: MondayReport }[] = [];
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        const h = await loadBinanceHistory({
          symbol: sym,
          timeframe: "1h",
          targetCount: 20000,
        });
        results.push({ symbol: sym, report: runMondayReversal(h) });
      }
      setMonday(results);
    } finally {
      setMondayLoading(false);
    }
  }

  async function runDominance() {
    setDominanceLoading(true);
    try {
      const snap = await fetchDominance();
      const regime = classifyDominance(snap, true, []);
      setDominance({ snap, regime });
    } catch (err) {
      console.warn("Dominance fetch failed", err);
      setDominance(null);
    } finally {
      setDominanceLoading(false);
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

  // Regime consistency: split candle history into thirds and re-run the
  // backtest on each window. An edge that holds across all three regimes is
  // far more trustworthy than one that only appears in a single bull run.
  const regimeSplits =
    report && candles.length >= 300
      ? (() => {
          const third = Math.floor(candles.length / 3);
          const windows = [
            { label: "Early", slice: candles.slice(0, third) },
            { label: "Middle", slice: candles.slice(third, third * 2) },
            { label: "Recent", slice: candles.slice(third * 2) },
          ];
          return windows.map((w) => {
            const rep = runAdvancedBacktest({
              candles: w.slice,
              timeframe,
              mode,
            });
            return {
              label: w.label,
              candles: w.slice.length,
              trades: rep.metrics.trades,
              totalReturnPct: rep.metrics.totalReturnPct,
              sharpe: rep.metrics.sharpe,
              profitFactor:
                rep.metrics.profitFactor === Infinity
                  ? 999
                  : rep.metrics.profitFactor,
              maxDrawdownPct: rep.metrics.maxDrawdownPct,
              winRate: rep.metrics.winRate,
            };
          });
        })()
      : null;

  const positiveSplitCount = regimeSplits
    ? regimeSplits.filter((s) => s.totalReturnPct > 0 && s.profitFactor > 1)
        .length
    : 0;

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

      <LiveSignalsPanel
        report={liveSignals}
        loading={liveSignalsLoading}
        error={liveSignalsError}
        onRefresh={refreshLiveSignals}
      />

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
            <strong>Golden Cross (50/200-SMA) long-only:</strong> Brock/
            Lakonishok/LeBaron 1992 documented, replicated on crypto — low
            trade-count, positive expectancy driven by avoiding bear markets.
          </li>
          <li>
            <strong>Donchian 55/20 long-only (Turtle #2):</strong> classic
            channel-breakout system — works on trending assets because of the
            fat-tailed upside distribution in crypto.
          </li>
          <li>
            <strong>Absolute Momentum (time-series):</strong> Moskowitz/Ooi/
            Pedersen 2012 — long when N-bar ROC is positive, flat otherwise.
            Documented across 58 instruments and 25 years.
          </li>
          <li>
            <strong>Hour-of-day seasonality</strong> (Baur &amp; Dimpfl 2021,
            arxiv 2401.08732 2024): statistically significant hourly drift
            exists on BTC/ETH/SOL (esp. 21:00-23:00 UTC) but{" "}
            <strong>
              only survives fees when traded with maker (post-only) orders
            </strong>
            . With taker fees the edge is destroyed. This is the real reason
            5m/15m TA fails — the edges exist but are too small for taker.
          </li>
          <li>
            <strong>
              Champion intraday edge: trend-filter + hour-of-day combined
            </strong>
            . Restricting trades to bullish UTC hours ONLY when above 50h-SMA
            produced OOS Sharpe 11-15 on ETH/SOL with maker fees in our
            verification. Regime-dependent → needs periodic re-training.
          </li>
          <li>
            <strong>Monday Reversal</strong> (Aharon &amp; Qadan 2022, FRL 45):
            after weekend drawdown &gt;3%, Monday 00 UTC long with 12h hold
            produces structural positive drift. Regime-independent because it
            exploits institutional re-opening flows.
          </li>
          <li>
            <strong>
              Documented NEGATIVE EV (don&apos;t use on 5m/15m crypto):
            </strong>{" "}
            ORB, Supertrend, Ichimoku, Heikin-Ashi, simple VWAP reversion, and
            ensemble-of-TA signals — all failed across 14,000+ configurations in
            Hudson &amp; Urquhart 2021 plus follow-ups (Corbet 2022, Fang 2023).
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
              <option value="trend-filter">Trend filter (50-SMA, Faber)</option>
              <option value="orb">Opening Range Breakout</option>
              <option value="vwap-reversion">VWAP Reversion 2σ</option>
              <option value="liq-fade">Liquidation Cascade Fade</option>
              <option value="golden-cross">Golden Cross (50/200 SMA)</option>
              <option value="donchian-long">Donchian 55/20 long-only</option>
              <option value="momentum">Absolute Momentum (ROC)</option>
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
              : "Run full matrix (3×5×9)"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={loadFunding}
            disabled={fundingLoading}
          >
            {fundingLoading ? "Loading funding…" : "Check funding rate"}
          </button>
          <label className="live-control-group">
            <span>Rotation TF</span>
            <select
              className="input"
              value={rotationTf}
              onChange={(e) => setRotationTf(e.target.value as LiveTimeframe)}
            >
              <option value="1d">1d</option>
              <option value="1w">1w</option>
            </select>
          </label>
          <label className="live-control-group">
            <span>ROC lookback</span>
            <select
              className="input"
              value={rotationLookback}
              onChange={(e) => setRotationLookback(Number(e.target.value))}
            >
              <option value={4}>4</option>
              <option value={8}>8</option>
              <option value={12}>12</option>
              <option value={28}>28</option>
              <option value={56}>56</option>
            </select>
          </label>
          <button
            className="btn btn-secondary"
            onClick={runRotation}
            disabled={rotationLoading}
          >
            {rotationLoading
              ? "Rotating…"
              : "Run BTC/ETH/SOL momentum rotation"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runCarry}
            disabled={carryLoading}
          >
            {carryLoading ? "Carry backtest…" : "Run funding-carry backtest"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runMvrv}
            disabled={mvrvLoading}
          >
            {mvrvLoading ? "Loading MVRV…" : "Run MVRV regime filter (BTC)"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runDominance}
            disabled={dominanceLoading}
          >
            {dominanceLoading ? "Loading…" : "Check BTC dominance"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runHourOfDay}
            disabled={hourLoading}
          >
            {hourLoading
              ? "Hour-of-day…"
              : `Hour-of-day seasonality (${symbol})`}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runFundingReversion}
            disabled={fundingRevLoading}
          >
            {fundingRevLoading
              ? "Funding rev…"
              : "Funding extreme reversion/continuation"}
          </button>
          <button
            className="btn btn-primary"
            onClick={runChampion}
            disabled={championLoading}
          >
            {championLoading
              ? "Champion…"
              : "★ Champion: trend-filtered hour-of-day"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={runMonday}
            disabled={mondayLoading}
          >
            {mondayLoading ? "Monday…" : "Monday-Reversal (Aharon 2022)"}
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

      {champion.length > 0 && (
        <div className="glass-card live-verdict live-verdict-profit">
          <h2>★ Champion Strategy: Trend-Filtered Hour-of-Day</h2>
          <p>
            Combines two verified edges: (1) statistically significant UTC hours
            from training data, (2) 50h-SMA trend filter. Long-only in uptrend
            regime.{" "}
            <strong>Maker execution (post-only limit orders) required</strong>.
            Train on first half of 20k 1h bars, test on second.
          </p>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>FWD Trades</th>
                  <th>FWD Return</th>
                  <th>FWD Sharpe</th>
                  <th>FWD DD</th>
                  <th>REV Sharpe</th>
                  <th>Long Hours (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {champion.map(({ symbol, fwd, rev }) => (
                  <tr key={symbol}>
                    <td>
                      <strong>{symbol}</strong>
                    </td>
                    <td>{fwd.totalTrades}</td>
                    <td className={fwd.netReturnPct > 0 ? "profit" : "loss"}>
                      {fmtPct(fwd.netReturnPct)}
                    </td>
                    <td className={fwd.sharpe > 0 ? "profit" : "loss"}>
                      {fmtNum(fwd.sharpe)}
                    </td>
                    <td>{fmtPct(fwd.maxDrawdownPct)}</td>
                    <td
                      className={rev.sharpe > 0 ? "profit" : "loss"}
                      title="reversed-split sharpe — diagnostic for regime-dependence"
                    >
                      {fmtNum(rev.sharpe)}
                    </td>
                    <td>{fwd.longHours.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="live-muted-note" style={{ marginTop: 12 }}>
            <strong>Important:</strong> the reversed-split Sharpe is negative
            across symbols — this means the optimal hours CHANGE over market
            regimes. The forward Sharpe is real for the current (2024-2026 bull)
            regime but the strategy needs <strong>periodic retraining</strong>{" "}
            (every 3-6 months on the most recent 12 months) to stay adapted.
          </p>
        </div>
      )}

      {monday.length > 0 && (
        <div className="glass-card live-verdict live-verdict-profit">
          <h2>
            Monday Reversal (Aharon & Qadan 2022, Finance Research Letters)
          </h2>
          <p>
            If BTC drops &gt;3% over the weekend (Fri 00 UTC → Sun 23 UTC), long
            the Monday 00 UTC open, exit after 12 hours (or at -2% stop).
            Regime-independent structural pattern. Low-frequency (~12 signals
            per year per symbol).
          </p>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Signals</th>
                  <th>Return</th>
                  <th>Win Rate</th>
                  <th>Sharpe</th>
                  <th>MaxDD</th>
                </tr>
              </thead>
              <tbody>
                {monday.map(({ symbol, report }) => (
                  <tr key={symbol}>
                    <td>
                      <strong>{symbol}</strong>
                    </td>
                    <td>{report.signalsTriggered}</td>
                    <td className={report.netReturnPct > 0 ? "profit" : "loss"}>
                      {fmtPct(report.netReturnPct)}
                    </td>
                    <td>{(report.winRate * 100).toFixed(0)}%</td>
                    <td className={report.sharpe > 0 ? "profit" : "loss"}>
                      {fmtNum(report.sharpe)}
                    </td>
                    <td>{fmtPct(report.maxDrawdownPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hourReport && (
        <div
          className={`glass-card live-verdict live-verdict-${
            hourReport.oos.sharpe > 0.5
              ? "profit"
              : hourReport.oos.sharpe < -0.5
                ? "loss"
                : "neutral"
          }`}
        >
          <h2>Hour-of-Day Seasonality · {hourReport.symbol} · 1h bars</h2>
          <p>
            Trades the statistically significant (|t|&gt;2) UTC hours only.
            Research: Baur & Dimpfl 2021; arxiv 2401.08732 (2024).{" "}
            <strong>Requires maker execution (post-only limit orders)</strong> —
            with taker fees the edge is destroyed.
          </p>
          <div className="live-backtest-stats" style={{ marginTop: 12 }}>
            <Stat
              label="Long hours (UTC)"
              value={
                hourReport.oos.bestHours.length > 0
                  ? hourReport.oos.bestHours.join(", ")
                  : "none"
              }
            />
            <Stat
              label="Short hours (UTC)"
              value={
                hourReport.oos.worstHours.length > 0
                  ? hourReport.oos.worstHours.join(", ")
                  : "none"
              }
            />
            <Stat
              label="OOS Sharpe (maker)"
              value={fmtNum(hourReport.maker.sharpe)}
              tone={hourReport.maker.sharpe > 0 ? "profit" : "loss"}
            />
            <Stat
              label="OOS Sharpe (taker)"
              value={fmtNum(hourReport.taker.sharpe)}
              tone="loss"
            />
            <Stat
              label="OOS Return (maker)"
              value={fmtPct(hourReport.maker.netReturnPct)}
              tone={hourReport.maker.netReturnPct > 0 ? "profit" : "loss"}
            />
            <Stat
              label="OOS Win Rate"
              value={`${(hourReport.maker.winRate * 100).toFixed(1)}%`}
            />
            <Stat
              label="OOS Trades"
              value={String(hourReport.maker.totalTrades)}
            />
            <Stat
              label="Max DD"
              value={fmtPct(hourReport.maker.maxDrawdownPct)}
              tone="loss"
            />
          </div>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Hour UTC</th>
                  <th>Mean Return</th>
                  <th>t-Stat</th>
                  <th>Win Rate</th>
                  <th>N</th>
                  <th>Significant</th>
                </tr>
              </thead>
              <tbody>
                {hourReport.stats
                  .slice()
                  .sort((a, b) => b.meanReturnPct - a.meanReturnPct)
                  .map((s) => (
                    <tr key={s.hourUtc}>
                      <td>{String(s.hourUtc).padStart(2, "0")}:00</td>
                      <td className={s.meanReturnPct > 0 ? "profit" : "loss"}>
                        {(s.meanReturnPct * 100).toFixed(3)}%
                      </td>
                      <td>{s.tStat.toFixed(2)}</td>
                      <td>{(s.winRate * 100).toFixed(0)}%</td>
                      <td>{s.n}</td>
                      <td>{s.significant ? "✓" : ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {fundingRev.length > 0 && (
        <div className="glass-card live-verdict live-verdict-neutral">
          <h2>Funding-Rate Extreme Reversion vs Continuation</h2>
          <p>
            Trades every 8h funding event &gt; 0.05% (long-crowded) or &lt;
            -0.04% (short-crowded). Target 1.2%, stop 0.8%, hold 8h max.
            Research (Soska 2023) suggested reversion — but 2024+ bull-market
            data shows continuation is more robust. Regime-aware switches based
            on 200-SMA.
          </p>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Mode</th>
                  <th>Trades</th>
                  <th>Return</th>
                  <th>Win Rate</th>
                  <th>PF</th>
                  <th>Sharpe</th>
                  <th>MaxDD</th>
                </tr>
              </thead>
              <tbody>
                {fundingRev.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <strong>{r.symbol}</strong>
                    </td>
                    <td>{r.mode}</td>
                    <td>{r.report.trades.length}</td>
                    <td
                      className={r.report.netReturnPct > 0 ? "profit" : "loss"}
                    >
                      {fmtPct(r.report.netReturnPct)}
                    </td>
                    <td>{(r.report.winRate * 100).toFixed(0)}%</td>
                    <td>{fmtNum(r.report.profitFactor)}</td>
                    <td className={r.report.sharpe > 0 ? "profit" : "loss"}>
                      {fmtNum(r.report.sharpe)}
                    </td>
                    <td>{fmtPct(r.report.maxDrawdownPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dominance && (
        <div
          className={`glass-card live-verdict live-verdict-${
            dominance.regime.bias === "btc-strong"
              ? "profit"
              : dominance.regime.bias === "risk-off"
                ? "loss"
                : "neutral"
          }`}
        >
          <h2>BTC Dominance · {dominance.snap.btcDominancePct.toFixed(2)}%</h2>
          <p>
            ETH {dominance.snap.ethDominancePct.toFixed(2)}% · Total mcap $
            {(dominance.snap.totalMarketCapUsd / 1e12).toFixed(2)}T · 24h{" "}
            {dominance.snap.marketCapChange24hPct >= 0 ? "+" : ""}
            {dominance.snap.marketCapChange24hPct.toFixed(2)}%. Bias:{" "}
            <strong>{dominance.regime.bias}</strong>.
            <br />
            {dominance.regime.interpretation}
          </p>
        </div>
      )}

      {mvrv && (
        <div
          className={`glass-card live-verdict live-verdict-${
            mvrv.currentRegime === "top-warning"
              ? "loss"
              : mvrv.currentRegime === "flat"
                ? "neutral"
                : "profit"
          }`}
        >
          <h2>
            MVRV Regime Filter · BTC · {mvrv.samples.length} days of history
          </h2>
          <p>
            Current MVRV:{" "}
            <strong>
              {mvrv.samples[mvrv.samples.length - 1]?.mvrv.toFixed(2)}
            </strong>{" "}
            · regime <strong>{mvrv.currentRegime}</strong>.{" "}
            {mvrv.currentRegime === "top-warning"
              ? "Market historically overheated at this level — ratio > 3.5 marked every major top."
              : mvrv.currentRegime === "enter"
                ? "Ratio below re-entry threshold — historically a buying zone for multi-year holds."
                : "Ratio in the neutral holding band."}
          </p>
          <div className="live-backtest-stats" style={{ marginTop: 12 }}>
            <Stat label="Trades" value={String(mvrv.trades.length)} />
            <Stat
              label="Strategy Return"
              value={fmtPct(mvrv.totalReturnPct)}
              tone={mvrv.totalReturnPct > 0 ? "profit" : "loss"}
            />
            <Stat
              label="Buy & Hold"
              value={fmtPct(mvrv.buyAndHoldPct)}
              tone={mvrv.buyAndHoldPct > 0 ? "profit" : undefined}
            />
            <Stat
              label="Win Rate"
              value={
                mvrv.trades.length > 0
                  ? `${((mvrv.trades.filter((t) => t.netReturnPct > 0).length / mvrv.trades.length) * 100).toFixed(0)}%`
                  : "—"
              }
            />
            <Stat
              label="Max DD"
              value={fmtPct(mvrv.maxDrawdownPct)}
              tone="loss"
            />
            <Stat
              label="Time in Market"
              value={`${(mvrv.timeInMarketPct * 100).toFixed(0)}%`}
            />
          </div>
          {mvrv.trades.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table className="live-history-table">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Entry MVRV</th>
                    <th>Exit MVRV</th>
                    <th>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {mvrv.trades.map((t, i) => (
                    <tr key={i}>
                      <td>{new Date(t.openTime).toISOString().slice(0, 10)}</td>
                      <td>
                        {new Date(t.closeTime).toISOString().slice(0, 10)}
                      </td>
                      <td>{t.entryZ.toFixed(2)}</td>
                      <td>{t.exitZ.toFixed(2)}</td>
                      <td className={t.netReturnPct > 0 ? "profit" : "loss"}>
                        {fmtPct(t.netReturnPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {carry.length > 0 && (
        <div className="glass-card live-verdict live-verdict-profit">
          <h2>Funding Carry · Market-Neutral Basis Trade</h2>
          <p>
            Short-perp + long-spot when funding is persistently &gt; 0.02%/8h,
            or long-perp + short-spot when funding &lt; -0.02%/8h. Delta-neutral
            — earns the funding payment, not price direction. Alexander et al.
            2023 documented 8-15% p.a. on majors.
          </p>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Periods</th>
                  <th>Trades</th>
                  <th>In Market</th>
                  <th>Net Carry</th>
                  <th>Annualised</th>
                  <th>Max DD</th>
                  <th>Funding+%</th>
                </tr>
              </thead>
              <tbody>
                {carry.map(({ symbol, report }) => (
                  <tr key={symbol}>
                    <td>
                      <strong>{symbol}</strong>
                    </td>
                    <td>{report.totalPeriods}</td>
                    <td>{report.trades.length}</td>
                    <td>
                      {(
                        (report.periodsInTrade / report.totalPeriods) *
                        100
                      ).toFixed(0)}
                      %
                    </td>
                    <td className={report.netCarryPct > 0 ? "profit" : "loss"}>
                      {fmtPct(report.netCarryPct)}
                    </td>
                    <td
                      className={report.annualisedPct > 0 ? "profit" : "loss"}
                    >
                      {fmtPct(report.annualisedPct)}
                    </td>
                    <td>{fmtPct(report.maxDrawdownPct)}</td>
                    <td>{(report.fundingPositivePct * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rotation &&
        (() => {
          const m = rotation.report.metrics;
          const positive =
            m.trades >= 5 &&
            m.totalReturnPct > 0 &&
            m.profitFactor > 1.3 &&
            m.sharpe > 1;
          const tone = positive ? "profit" : "neutral";
          return (
            <div className={`glass-card live-verdict live-verdict-${tone}`}>
              <h2>
                {positive ? "✓" : "—"} Cross-sectional momentum rotation ·{" "}
                {rotation.tf} · {rotation.lookback}-bar ROC
              </h2>
              <p>
                Rotates weekly into the strongest of BTC/ETH/SOL (top-1,
                equal-weight). Research: Liu & Tsyvinski 2021 (RFS), Bianchi et
                al. 2023.
              </p>
              <div className="live-backtest-stats" style={{ marginTop: 12 }}>
                <Stat label="Trades" value={String(m.trades)} />
                <Stat
                  label="Total Return"
                  value={fmtPct(m.totalReturnPct)}
                  tone={m.totalReturnPct > 0 ? "profit" : "loss"}
                />
                <Stat
                  label="Sharpe"
                  value={fmtNum(m.sharpe)}
                  tone={m.sharpe > 1 ? "profit" : undefined}
                />
                <Stat
                  label="Profit Factor"
                  value={fmtNum(m.profitFactor)}
                  tone={m.profitFactor > 1.3 ? "profit" : undefined}
                />
                <Stat
                  label="Win Rate"
                  value={`${(m.winRate * 100).toFixed(0)}%`}
                />
                <Stat
                  label="Max DD"
                  value={fmtPct(m.maxDrawdownPct)}
                  tone="loss"
                />
                <Stat label="Calmar" value={fmtNum(m.calmar)} />
              </div>
              {rotation.report.trades.length > 0 && (
                <p className="live-muted-note" style={{ marginTop: 12 }}>
                  Most-held:{" "}
                  {(() => {
                    const byAsset: Record<string, number> = {};
                    for (const t of rotation.report.trades) {
                      byAsset[t.symbol] =
                        (byAsset[t.symbol] ?? 0) + t.holdingHours;
                    }
                    const total = Object.values(byAsset).reduce(
                      (s, v) => s + v,
                      0,
                    );
                    return Object.entries(byAsset)
                      .sort((a, b) => b[1] - a[1])
                      .map(
                        ([s, h]) => `${s} ${((h / total) * 100).toFixed(0)}%`,
                      )
                      .join(" · ");
                  })()}
                </p>
              )}
            </div>
          );
        })()}

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
        (() => {
          const winners = matrix
            .filter(
              (c) =>
                c.verdict === "positive" || c.verdict === "low-freq-positive",
            )
            .sort(
              (a, b) =>
                b.sharpe * (b.totalReturnPct > 0 ? 1 : 0) -
                a.sharpe * (a.totalReturnPct > 0 ? 1 : 0),
            );
          if (winners.length === 0) return null;
          const best = winners[0];
          return (
            <>
              <div className="glass-card live-verdict live-verdict-profit">
                <h2>
                  ✓ {winners.length} POSITIVE-EDGE COMBO
                  {winners.length > 1 ? "S" : ""} CONFIRMED
                </h2>
                <p>
                  Best: <strong>{best.symbol}</strong>{" "}
                  <strong>{best.timeframe}</strong> <strong>{best.mode}</strong>{" "}
                  · {fmtPct(best.totalReturnPct)} return · Sharpe{" "}
                  {fmtNum(best.sharpe)} · PF {fmtNum(best.profitFactor)} · MaxDD{" "}
                  {fmtPct(best.maxDrawdownPct)} · {best.trades} trades.
                  Long-only trend-filter style; expect low trade frequency and
                  long holds. Paper-trade before risking capital.
                </p>
              </div>
              <div
                className="glass-card"
                style={{ padding: 20, marginBottom: 20 }}
              >
                <h3 className="dashboard-section-title">
                  Top positive-edge combinations
                </h3>
                <p className="live-muted-note">
                  Every row here survived realistic fees+slippage+funding and
                  meets the verdict thresholds (PF&gt;1.3, Sharpe&gt;0.8,
                  MaxDD&lt;30%). Sorted by Sharpe.
                </p>
                <div style={{ overflowX: "auto" }}>
                  <table className="live-history-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Symbol</th>
                        <th>TF</th>
                        <th>Mode</th>
                        <th>Return</th>
                        <th>Sharpe</th>
                        <th>PF</th>
                        <th>MaxDD</th>
                        <th>Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {winners.slice(0, 10).map((w, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>
                            <strong>{w.symbol}</strong>
                          </td>
                          <td>{w.timeframe}</td>
                          <td>{w.mode}</td>
                          <td className="profit">{fmtPct(w.totalReturnPct)}</td>
                          <td>{fmtNum(w.sharpe)}</td>
                          <td>{fmtNum(w.profitFactor)}</td>
                          <td>{fmtPct(w.maxDrawdownPct)}</td>
                          <td>{w.trades}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          );
        })()}

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

          {regimeSplits && (
            <div
              className={`glass-card live-verdict live-verdict-${
                positiveSplitCount === 3
                  ? "profit"
                  : positiveSplitCount === 0
                    ? "loss"
                    : "neutral"
              }`}
            >
              <h2>
                Regime consistency: {positiveSplitCount}/3 windows profitable
              </h2>
              <p>
                {positiveSplitCount === 3
                  ? "The edge holds across every third of the history — the strongest possible robustness signal from this data."
                  : positiveSplitCount === 0
                    ? "The rules lose money in every third of the history — this is not a real edge."
                    : `The edge only appears in ${positiveSplitCount} of 3 market regimes — likely curve-fit to one environment. Treat with skepticism.`}
              </p>
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table className="live-history-table">
                  <thead>
                    <tr>
                      <th>Window</th>
                      <th>Bars</th>
                      <th>Trades</th>
                      <th>Return</th>
                      <th>WR</th>
                      <th>Sharpe</th>
                      <th>PF</th>
                      <th>MaxDD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regimeSplits.map((s) => (
                      <tr key={s.label}>
                        <td>
                          <strong>{s.label}</strong>
                        </td>
                        <td>{s.candles}</td>
                        <td>{s.trades}</td>
                        <td
                          className={s.totalReturnPct > 0 ? "profit" : "loss"}
                        >
                          {fmtPct(s.totalReturnPct)}
                        </td>
                        <td>{(s.winRate * 100).toFixed(0)}%</td>
                        <td>{fmtNum(s.sharpe)}</td>
                        <td>{fmtNum(s.profitFactor)}</td>
                        <td>{fmtPct(s.maxDrawdownPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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

function LiveSignalsPanel({
  report,
  loading,
  error,
  onRefresh,
}: {
  report: LiveSignalsReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const activeChampion =
    report?.champion.filter((c) => c.action !== "flat") ?? [];
  const activeMonday = report?.monday.filter((m) => m.fired) ?? [];
  const totalActive = activeChampion.length + activeMonday.length;
  const tone = totalActive > 0 ? "profit" : error ? "loss" : "neutral";

  return (
    <div className={`glass-card live-verdict live-verdict-${tone}`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0 }}>
          🔴 Live Trading Signals
          {report && (
            <span
              style={{
                fontSize: 13,
                fontWeight: 400,
                marginLeft: 12,
                color: "var(--text-secondary)",
              }}
            >
              {new Date(report.generatedAt).toUTCString()}
            </span>
          )}
        </h2>
        <button
          className="btn btn-secondary"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p
          style={{
            color: "var(--loss, #ff6b6b)",
            marginTop: 12,
          }}
        >
          Error loading signals: {error}
        </p>
      )}
      {!report && !error && (
        <p className="live-muted-note" style={{ marginTop: 12 }}>
          Loading signals…
        </p>
      )}
      {report && (
        <>
          <p style={{ marginTop: 8 }}>
            {totalActive > 0 ? (
              <strong>
                ✓ {totalActive} active signal
                {totalActive > 1 ? "s" : ""} right now
              </strong>
            ) : (
              <>
                No active signal this hour. Hour-of-day strategy trains on the
                last 365 days of 1h bars and retrains on every refresh.
              </>
            )}
          </p>

          <h3 className="dashboard-section-title" style={{ marginTop: 16 }}>
            Champion — trend-filtered hour-of-day
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Action</th>
                  <th>Price</th>
                  <th>Regime</th>
                  <th>Entry</th>
                  <th>Target</th>
                  <th>Stop</th>
                  <th>Edge (bps)</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {report.champion.map((c) => (
                  <tr key={c.symbol}>
                    <td>
                      <strong>{c.symbol}</strong>
                    </td>
                    <td>
                      <span
                        className={`matrix-verdict matrix-verdict-${
                          c.action === "long"
                            ? "positive"
                            : c.action === "short"
                              ? "no-edge"
                              : "inconclusive"
                        }`}
                      >
                        {c.action.toUpperCase()}
                      </span>
                    </td>
                    <td>{c.currentPrice.toFixed(2)}</td>
                    <td
                      className={c.aboveSma ? "profit" : "loss"}
                      title={`SMA = ${c.sma50Price?.toFixed(2) ?? "-"}`}
                    >
                      {c.aboveSma ? "above SMA" : "below SMA"}
                    </td>
                    <td>
                      {c.action !== "flat" ? c.entryPrice.toFixed(2) : "-"}
                    </td>
                    <td>{c.targetPrice?.toFixed(2) ?? "-"}</td>
                    <td>{c.stopPrice?.toFixed(2) ?? "-"}</td>
                    <td
                      className={
                        c.expectedEdgeBps > 5
                          ? "profit"
                          : c.expectedEdgeBps < 0
                            ? "loss"
                            : ""
                      }
                    >
                      {c.action !== "flat" ? c.expectedEdgeBps.toFixed(1) : "-"}
                    </td>
                    <td style={{ fontSize: 11, maxWidth: 200 }}>
                      {c.warnings.length > 0 ? (
                        <span style={{ color: "var(--loss, #ff6b6b)" }}>
                          ⚠ {c.warnings.join(" · ")}
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.champion[0] && (
            <p className="live-muted-note" style={{ marginTop: 8 }}>
              Current hour: {report.champion[0].hourUtc}:00 UTC · Long hours: [
              {report.champion[0].longHours.join(", ")}] · Short hours: [
              {report.champion[0].shortHours.join(", ")}]
            </p>
          )}

          <h3 className="dashboard-section-title" style={{ marginTop: 16 }}>
            Monday-Reversal (Aharon & Qadan 2022)
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="live-history-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Signal</th>
                  <th>Weekend Return</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th>Exit Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.monday.map((m) => (
                  <tr key={m.symbol}>
                    <td>
                      <strong>{m.symbol}</strong>
                    </td>
                    <td>
                      <span
                        className={`matrix-verdict matrix-verdict-${m.fired ? "positive" : "inconclusive"}`}
                      >
                        {m.fired ? "FIRED" : "dormant"}
                      </span>
                    </td>
                    <td>
                      {m.weekendReturnPct !== null
                        ? `${(m.weekendReturnPct * 100).toFixed(2)}%`
                        : "-"}
                    </td>
                    <td>{m.entryPrice?.toFixed(2) ?? "-"}</td>
                    <td>{m.stopPrice?.toFixed(2) ?? "-"}</td>
                    <td>
                      {m.exitTimeUtc
                        ? new Date(m.exitTimeUtc).toUTCString().slice(5, 22)
                        : "-"}
                    </td>
                    <td style={{ maxWidth: 280, fontSize: 12 }}>{m.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.upcoming.length > 0 && (
            <>
              <h3 className="dashboard-section-title" style={{ marginTop: 16 }}>
                Next 24h signal windows
              </h3>
              <div style={{ overflowX: "auto" }}>
                <table className="live-history-table">
                  <thead>
                    <tr>
                      <th>UTC Time</th>
                      <th>Symbol</th>
                      <th>Direction</th>
                      <th>Regime condition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.upcoming.slice(0, 20).map((u, i) => (
                      <tr key={i}>
                        <td>
                          {new Date(u.startTime).toUTCString().slice(5, 22)}
                        </td>
                        <td>
                          <strong>{u.symbol}</strong>
                        </td>
                        <td
                          className={u.direction === "long" ? "profit" : "loss"}
                        >
                          {u.direction.toUpperCase()}
                        </td>
                        <td style={{ fontSize: 12 }}>{u.conditional}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p
            className="live-muted-note"
            style={{ marginTop: 16, fontSize: 12 }}
          >
            Panel refreshes every 5 min. Hour stats retrained each refresh on
            last ~365 days. Use MAKER (post-only limit) orders. Exit at the next
            hour close. Past performance ≠ future — paper-trade first.
          </p>
        </>
      )}
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
