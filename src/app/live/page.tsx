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
import { useSignalTracking } from "@/hooks/useSignalTracking";
import {
  analyzeCandles,
  SignalSnapshot,
  hasActionChanged,
  deriveHtfTrend,
  backtest,
  walkForwardBacktest,
  monteCarloBacktest,
  multiTimeframeConsensus,
  suggestPositionSize,
  WalkForwardResult,
  MonteCarloResult,
  ConsensusResult,
} from "@/utils/signalEngine";
import {
  findPivots,
  extractKeyLevels,
  analyzeMarketStructure,
  classifySetup,
  computeBaseRate,
  bollingerBands,
  vwap,
} from "@/utils/marketStructure";
import { buildThesis, atrPercentile } from "@/utils/narrative";
import { atr as atrFn } from "@/utils/indicators";
import { ReferenceLine } from "recharts";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
] as const;
const TIMEFRAMES: LiveTimeframe[] = ["1m", "5m", "15m", "1h"];
const MAX_HISTORY_SIGNALS = 20;

const HTF_FOR: Record<LiveTimeframe, LiveTimeframe> = {
  "1m": "15m",
  "5m": "1h",
  "15m": "1h",
  "1h": "4h",
  "2h": "4h",
  "4h": "1d",
  "1d": "1w",
  "1w": "1w",
};

const CONSENSUS_TFS: Record<LiveTimeframe, LiveTimeframe[]> = {
  "1m": ["1m", "5m", "15m"],
  "5m": ["5m", "15m", "1h"],
  "15m": ["15m", "1h"],
  "1h": ["1h", "4h"],
  "2h": ["2h", "4h"],
  "4h": ["4h", "1d"],
  "1d": ["1d", "1w"],
  "1w": ["1w"],
};

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
  const [notify, setNotify] = useState(false);
  const [walkForward, setWalkForward] = useState<WalkForwardResult | null>(
    null,
  );
  const [monteCarlo, setMonteCarlo] = useState<MonteCarloResult | null>(null);
  const [accountSize, setAccountSize] = useState<number>(10_000);
  const [riskPercent, setRiskPercent] = useState<number>(1);
  const lastEmittedRef = useRef<SignalSnapshot | null>(null);

  const { candles, status, error } = useLiveCandles({
    symbol,
    timeframe,
    history: 300,
  });
  const htfTimeframe = HTF_FOR[timeframe];
  const htf = useLiveCandles({ symbol, timeframe: htfTimeframe, history: 120 });

  // Pull consensus timeframes
  const consensusTfs = CONSENSUS_TFS[timeframe];
  const tf1Candles = useLiveCandles({
    symbol,
    timeframe: consensusTfs[1] ?? timeframe,
    history: 120,
  });
  const tf2Candles = useLiveCandles({
    symbol,
    timeframe: consensusTfs[2] ?? timeframe,
    history: 120,
  });

  const htfTrend = useMemo(() => deriveHtfTrend(htf.candles), [htf.candles]);

  const snapshot = useMemo<SignalSnapshot | null>(() => {
    if (candles.length === 0) return null;
    return analyzeCandles(candles, { htfTrend });
  }, [candles, htfTrend]);

  const consensus = useMemo<ConsensusResult | null>(() => {
    const sets: { label: string; candles: typeof candles }[] = [
      { label: timeframe, candles },
    ];
    if (consensusTfs[1] && tf1Candles.candles.length > 0)
      sets.push({ label: consensusTfs[1], candles: tf1Candles.candles });
    if (consensusTfs[2] && tf2Candles.candles.length > 0)
      sets.push({ label: consensusTfs[2], candles: tf2Candles.candles });
    if (sets.length < 2) return null;
    return multiTimeframeConsensus(sets);
  }, [
    timeframe,
    candles,
    consensusTfs,
    tf1Candles.candles,
    tf2Candles.candles,
  ]);

  // Gated action: requires base signal + consensus agreement
  const gatedAction = useMemo<"long" | "short" | "flat">(() => {
    if (!snapshot) return "flat";
    if (snapshot.action === "flat") return "flat";
    if (!consensus) return snapshot.action;
    if (consensus.action !== snapshot.action) return "flat";
    if (consensus.agreementRatio < 0.66) return "flat";
    return snapshot.action;
  }, [snapshot, consensus]);

  const confidence = useMemo(() => {
    if (!snapshot || gatedAction === "flat") return 0;
    const baseStrength = snapshot.strength / 10; // 0..1
    const consensusWeight = consensus ? consensus.agreementRatio : 0.5;
    // Confidence is the joint signal — needs strong local + broad agreement
    const joint = baseStrength * 0.6 + consensusWeight * 0.4;
    return Math.round(joint * 100);
  }, [snapshot, consensus, gatedAction]);

  const priceNow =
    candles.length > 0 ? candles[candles.length - 1].close : null;

  // ---------- Deep analysis layer ----------
  const analysis = useMemo(() => {
    if (candles.length < 60 || !snapshot) return null;
    const pivots = findPivots(candles, 5, 5);
    const structure = analyzeMarketStructure(candles, pivots);
    const keyLevels = extractKeyLevels(pivots, snapshot.price);
    const setup = classifySetup(
      gatedAction,
      structure,
      keyLevels,
      snapshot.price,
      snapshot.indicators.atr,
    );
    const baseRate = computeBaseRate(candles, gatedAction, setup.type);
    const closes = candles.map((c) => c.close);
    const bb = bollingerBands(closes, 20, 2);
    const bbWidthPct = bb.widthPct.at(-1) ?? null;
    const vwapPts = vwap(candles);
    const vwapNow = vwapPts.at(-1)?.vwap ?? null;
    const atrSeries = atrFn(candles, 14);
    const atrPct = atrPercentile(atrSeries);
    return {
      pivots,
      structure,
      keyLevels,
      setup,
      baseRate,
      bbWidthPct,
      vwapNow,
      atrPct,
    };
  }, [candles, snapshot, gatedAction]);

  const thesis = useMemo(() => {
    if (!snapshot || !analysis) return null;
    return buildThesis({
      symbol,
      timeframe,
      snapshot,
      gatedAction,
      consensusConfidence: consensus?.confidence ?? 0,
      structure: analysis.structure,
      keyLevels: analysis.keyLevels,
      setup: analysis.setup,
      baseRate: analysis.baseRate,
      vwap: analysis.vwapNow,
      bbWidthPct: analysis.bbWidthPct,
      atrPercentile: analysis.atrPct,
    });
  }, [snapshot, analysis, symbol, timeframe, gatedAction, consensus]);

  const tracking = useSignalTracking({
    symbol,
    timeframe,
    snapshot:
      gatedAction === "flat"
        ? snapshot
          ? { ...snapshot, action: "flat" as const }
          : null
        : snapshot,
    confidence,
    currentPrice: priceNow,
  });

  // Closed-signal stats for honest accuracy display
  const tracked = tracking.tracked.filter((t) => t.symbol === symbol);
  const closedTracked = tracked.filter(
    (t) => t.status === "win" || t.status === "loss",
  );
  const trackedWinRate =
    closedTracked.length > 0
      ? closedTracked.filter((t) => t.status === "win").length /
        closedTracked.length
      : null;

  useEffect(() => {
    if (!snapshot) return;
    const effective: SignalSnapshot = { ...snapshot, action: gatedAction };
    if (hasActionChanged(lastEmittedRef.current, effective)) {
      lastEmittedRef.current = effective;
      setSignalHistory((prev) =>
        [effective, ...prev].slice(0, MAX_HISTORY_SIGNALS),
      );

      if (
        notify &&
        !tracking.circuitBreakerActive &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        effective.action !== "flat"
      ) {
        const title = `${effective.action === "long" ? "BUY" : "SELL"} ${symbol} · ${confidence}%`;
        const body = `${priceNow !== null ? formatPrice(priceNow) : ""} · ${timeframe}`;
        try {
          new Notification(title, { body, tag: `live-signal-${symbol}` });
        } catch {
          /* ignore */
        }
      }
    }
  }, [
    snapshot,
    gatedAction,
    notify,
    symbol,
    confidence,
    priceNow,
    timeframe,
    tracking.circuitBreakerActive,
  ]);

  useEffect(() => {
    setSignalHistory([]);
    lastEmittedRef.current = null;
    setWalkForward(null);
    setMonteCarlo(null);
  }, [symbol, timeframe]);

  const chartData = useMemo(() => {
    const slice = candles.slice(-120);
    const signalByTime = new Map<number, SignalSnapshot>();
    for (const s of signalHistory) signalByTime.set(s.time, s);
    return slice.map((c) => ({
      time: formatTime(c.closeTime),
      price: c.close,
      buy: signalByTime.get(c.closeTime)?.action === "long" ? c.close : null,
      sell: signalByTime.get(c.closeTime)?.action === "short" ? c.close : null,
    }));
  }, [candles, signalHistory]);

  const priceChange =
    candles.length > 1
      ? ((candles[candles.length - 1].close - candles[0].close) /
          candles[0].close) *
        100
      : 0;

  async function handleNotifyToggle() {
    if (notify) {
      setNotify(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      setNotify(true);
      return;
    }
    const res = await Notification.requestPermission();
    if (res === "granted") setNotify(true);
  }

  function runAnalysis() {
    if (candles.length < 60) return;
    const full = backtest(candles);
    const wf = walkForwardBacktest(candles);
    const mc = monteCarloBacktest(full.trades);
    setWalkForward(wf);
    setMonteCarlo(mc);
  }

  const positionSize = useMemo(() => {
    if (!snapshot?.levels || gatedAction === "flat") return null;
    return suggestPositionSize({
      accountSize,
      riskPercent,
      entry: snapshot.levels.entry,
      stopLoss: snapshot.levels.stopLoss,
    });
  }, [snapshot, gatedAction, accountSize, riskPercent]);

  const actionLabel = snapshot
    ? gatedAction === "long"
      ? "BUY"
      : gatedAction === "short"
        ? "SELL"
        : "HOLD"
    : "…";
  const actionClass = snapshot
    ? `live-action ${gatedAction}`
    : "live-action flat";
  const htfLabel =
    htfTrend === "long"
      ? "UP"
      : htfTrend === "short"
        ? "DOWN"
        : htfTrend === "flat"
          ? "FLAT"
          : "…";

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Live Signals</h1>
          <p className="page-subtitle">
            Multi-TF consensus · ADX regime · ATR stops · walk-forward ·
            Monte-Carlo drawdown
          </p>
        </div>
      </div>

      <div className="live-disclaimer" role="alert">
        <strong>Educational only, not financial advice.</strong> „Blind
        vertrauen" ist bei öffentlichen Signal-Bots nicht realistisch. Diese
        Seite ergänzt nur Transparenz, Risk-Management und Statistik — du
        triffst weiterhin jede Trade-Entscheidung selbst.
      </div>

      {tracking.circuitBreakerActive && (
        <div className="live-circuit-breaker" role="alert">
          🚨 <strong>Circuit Breaker aktiv:</strong> 3 Verlust-Signale heute auf{" "}
          {symbol}. Signale werden nicht als Empfehlung markiert — Kopf
          abkühlen, morgen weiter.
        </div>
      )}

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

        <button
          type="button"
          className={`btn btn-ghost ${notify ? "active" : ""}`}
          onClick={handleNotifyToggle}
          aria-pressed={notify}
        >
          {notify ? "🔔 Notify on" : "🔕 Notify off"}
        </button>

        <div className="live-status" aria-live="polite">
          <span className={`live-status-dot live-status-${status}`} />
          <span>
            {status === "loading" && "Loading…"}
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
              <div className="live-confidence">
                <div className="live-confidence-header">
                  <span>Confidence</span>
                  <strong>{confidence}%</strong>
                </div>
                <div className="live-confidence-bar">
                  <div
                    className={`live-confidence-fill ${confidence >= 70 ? "high" : confidence >= 40 ? "mid" : "low"}`}
                    style={{ width: `${confidence}%` }}
                  />
                </div>
                {confidence < 40 && gatedAction !== "flat" && (
                  <span className="live-confidence-warning">
                    ⚠ Low confidence — consider skipping this trade.
                  </span>
                )}
              </div>

              <div className="live-badges">
                <span className={`live-badge regime-${snapshot.regime}`}>
                  {snapshot.regime === "trending"
                    ? "📈 Trending"
                    : snapshot.regime === "ranging"
                      ? "↔ Ranging"
                      : "Regime?"}
                  {snapshot.adx !== null
                    ? ` · ADX ${snapshot.adx.toFixed(1)}`
                    : ""}
                </span>
                <span className={`live-badge htf-${htfTrend ?? "unknown"}`}>
                  HTF {htfTimeframe}: {htfLabel}
                </span>
                {consensus && (
                  <span className={`live-badge consensus-${consensus.action}`}>
                    Consensus: {consensus.confidence}% (
                    {consensus.detail
                      .map(
                        (d) =>
                          `${d.label}:${d.action === "long" ? "↑" : d.action === "short" ? "↓" : "–"}`,
                      )
                      .join(" ")}
                    )
                  </span>
                )}
              </div>

              {snapshot.levels && gatedAction !== "flat" && (
                <div className="live-levels">
                  <div className="live-level-row">
                    <span>Entry</span>
                    <strong>{formatPrice(snapshot.levels.entry)}</strong>
                  </div>
                  <div className="live-level-row">
                    <span>Stop Loss</span>
                    <strong className="loss">
                      {formatPrice(snapshot.levels.stopLoss)}
                    </strong>
                  </div>
                  <div className="live-level-row">
                    <span>Take Profit</span>
                    <strong className="profit">
                      {formatPrice(snapshot.levels.takeProfit)}
                    </strong>
                  </div>
                  <div className="live-level-row">
                    <span>R:R</span>
                    <strong>1 : {snapshot.levels.riskReward.toFixed(2)}</strong>
                  </div>
                </div>
              )}

              {positionSize && gatedAction !== "flat" && (
                <div className="live-position-size">
                  <div className="live-position-size-inputs">
                    <label>
                      <span>Account $</span>
                      <input
                        type="number"
                        className="input"
                        min={0}
                        value={accountSize}
                        onChange={(e) => setAccountSize(Number(e.target.value))}
                      />
                    </label>
                    <label>
                      <span>Risk %</span>
                      <input
                        type="number"
                        className="input"
                        step={0.1}
                        min={0.1}
                        max={10}
                        value={riskPercent}
                        onChange={(e) => setRiskPercent(Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <div className="live-position-size-output">
                    Suggested size:{" "}
                    <strong>
                      {positionSize.quantity.toFixed(
                        positionSize.quantity < 1 ? 4 : 2,
                      )}
                    </strong>
                    <span>
                      {" "}
                      ($ {positionSize.dollarRisk.toFixed(2)} max loss)
                    </span>
                  </div>
                </div>
              )}

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
                  label="ATR"
                  value={fmtNum(snapshot.indicators.atr, 2)}
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
                  <Area
                    type="monotone"
                    dataKey="buy"
                    stroke="#00ff88"
                    fill="transparent"
                    dot={{ r: 6, fill: "#00ff88", stroke: "#00ff88" }}
                    activeDot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="sell"
                    stroke="#ff4757"
                    fill="transparent"
                    dot={{ r: 6, fill: "#ff4757", stroke: "#ff4757" }}
                    activeDot={false}
                  />
                  {analysis?.keyLevels.supports.map((s) => (
                    <ReferenceLine
                      key={`sup-${s}`}
                      y={s}
                      stroke="rgba(0,255,136,0.35)"
                      strokeDasharray="4 4"
                      label={{
                        value: `S ${s.toFixed(0)}`,
                        position: "right",
                        fill: "#00ff88",
                        fontSize: 10,
                      }}
                    />
                  ))}
                  {analysis?.keyLevels.resistances.map((r) => (
                    <ReferenceLine
                      key={`res-${r}`}
                      y={r}
                      stroke="rgba(255,71,87,0.35)"
                      strokeDasharray="4 4"
                      label={{
                        value: `R ${r.toFixed(0)}`,
                        position: "right",
                        fill: "#ff4757",
                        fontSize: 10,
                      }}
                    />
                  ))}
                  {analysis?.vwapNow && (
                    <ReferenceLine
                      y={analysis.vwapNow}
                      stroke="rgba(139, 92, 246, 0.5)"
                      strokeDasharray="2 6"
                      label={{
                        value: `VWAP`,
                        position: "left",
                        fill: "#a78bfa",
                        fontSize: 10,
                      }}
                    />
                  )}
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

      {thesis && (
        <div className="glass-card live-thesis-card">
          <div className="live-thesis-header">
            <h3 className="dashboard-section-title">Trade Thesis</h3>
            {analysis && (
              <div className="live-thesis-meta">
                <span className={`live-badge setup-${analysis.setup.type}`}>
                  {analysis.setup.type.replace("-", " ")}
                </span>
                <span
                  className={`live-badge structure-${analysis.structure.state}`}
                >
                  Structure: {analysis.structure.state}
                </span>
                {analysis.structure.lastEvent !== "none" && (
                  <span
                    className={`live-badge event-${analysis.structure.lastEvent.includes("up") ? "up" : "down"}`}
                  >
                    {analysis.structure.lastEvent}
                  </span>
                )}
              </div>
            )}
          </div>

          <h4 className="live-thesis-headline">{thesis.headline}</h4>

          <div className="live-thesis-sections">
            <section>
              <h5>Context</h5>
              <p>{thesis.context}</p>
            </section>
            <section>
              <h5>Setup</h5>
              <p>{thesis.setup}</p>
            </section>
            <section>
              <h5>Execution</h5>
              <p>{thesis.execution}</p>
            </section>
            <section>
              <h5>Invalidation</h5>
              <p>{thesis.invalidation}</p>
            </section>
            <section>
              <h5>Counter-arguments</h5>
              <ul className="live-thesis-counter">
                {thesis.counterArguments.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          </div>

          {analysis?.baseRate && (
            <div className="live-base-rate">
              <h5 className="live-section-subtitle">
                Historical Base Rate for this Setup
              </h5>
              <div className="live-backtest-stats">
                <BaseStatCell
                  label="Sample"
                  value={`n=${analysis.baseRate.samples}`}
                />
                <BaseStatCell
                  label="Win Rate"
                  value={`${(analysis.baseRate.winRate * 100).toFixed(0)}%`}
                  variant={analysis.baseRate.winRate >= 0.5 ? "profit" : "loss"}
                />
                <BaseStatCell
                  label="95% CI"
                  value={`${(analysis.baseRate.confidenceLower * 100).toFixed(0)}–${(analysis.baseRate.confidenceUpper * 100).toFixed(0)}%`}
                />
                <BaseStatCell
                  label="Avg R"
                  value={`${analysis.baseRate.avgR >= 0 ? "+" : ""}${analysis.baseRate.avgR.toFixed(2)}`}
                  variant={analysis.baseRate.avgR >= 0 ? "profit" : "loss"}
                />
              </div>
              {analysis.baseRate.samples < 20 && (
                <p className="live-muted-note">
                  ⚠ Small sample — the confidence interval is wide. Treat the
                  win-rate estimate with caution.
                </p>
              )}
            </div>
          )}

          {analysis?.keyLevels &&
            (analysis.keyLevels.supports.length > 0 ||
              analysis.keyLevels.resistances.length > 0) && (
              <div className="live-key-levels">
                <h5 className="live-section-subtitle">Key Levels</h5>
                <div className="live-levels-grid">
                  {analysis.keyLevels.resistances.map((r) => (
                    <div key={`kr-${r}`} className="live-level-pill resistance">
                      R {r.toFixed(2)}
                    </div>
                  ))}
                  {analysis.keyLevels.supports.map((s) => (
                    <div key={`ks-${s}`} className="live-level-pill support">
                      S {s.toFixed(2)}
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}

      <div className="glass-card live-backtest-card">
        <div className="live-backtest-header">
          <h3 className="dashboard-section-title">Reliability Analysis</h3>
          <button
            className="btn btn-secondary"
            onClick={runAnalysis}
            disabled={candles.length < 60}
          >
            Run walk-forward + Monte-Carlo
          </button>
        </div>
        {walkForward ? (
          <>
            <h4 className="live-section-subtitle">
              In-Sample vs Out-of-Sample (70/30 split)
            </h4>
            <div className="live-backtest-stats">
              <BacktestStat
                label="IS Win Rate"
                value={`${(walkForward.inSample.winRate * 100).toFixed(1)}%`}
              />
              <BacktestStat
                label="OOS Win Rate"
                value={`${(walkForward.outOfSample.winRate * 100).toFixed(1)}%`}
                variant={
                  walkForward.outOfSample.winRate >=
                  walkForward.inSample.winRate * 0.8
                    ? "profit"
                    : "loss"
                }
              />
              <BacktestStat
                label="IS Profit Factor"
                value={pfLabel(walkForward.inSample.profitFactor)}
              />
              <BacktestStat
                label="OOS Profit Factor"
                value={pfLabel(walkForward.outOfSample.profitFactor)}
                variant={
                  walkForward.outOfSample.profitFactor >= 1 ? "profit" : "loss"
                }
              />
              <BacktestStat
                label="IS Trades"
                value={String(walkForward.inSample.trades.length)}
              />
              <BacktestStat
                label="OOS Trades"
                value={String(walkForward.outOfSample.trades.length)}
              />
            </div>
            {walkForward.overfitWarning && (
              <p className="live-warning">
                ⚠ <strong>Overfitting-Verdacht:</strong> In-Sample-Performance
                ist deutlich besser als Out-of-Sample. Die Regeln generalisieren
                aktuell nicht — vertrau den Live-Signalen mit Skepsis.
              </p>
            )}

            {monteCarlo && (
              <>
                <h4 className="live-section-subtitle">
                  Monte-Carlo ({monteCarlo.runs} runs)
                </h4>
                <div className="live-backtest-stats">
                  <BacktestStat
                    label="Prob. of Profit"
                    value={`${(monteCarlo.probOfProfit * 100).toFixed(0)}%`}
                    variant={
                      monteCarlo.probOfProfit >= 0.6
                        ? "profit"
                        : monteCarlo.probOfProfit < 0.5
                          ? "loss"
                          : undefined
                    }
                  />
                  <BacktestStat
                    label="Median Max DD"
                    value={`${monteCarlo.medianMaxDrawdownR.toFixed(2)} R`}
                  />
                  <BacktestStat
                    label="P95 Max DD"
                    value={`${monteCarlo.p95MaxDrawdownR.toFixed(2)} R`}
                    variant="loss"
                  />
                  <BacktestStat
                    label="Worst-case DD"
                    value={`${monteCarlo.worstMaxDrawdownR.toFixed(2)} R`}
                    variant="loss"
                  />
                </div>
                <p className="live-muted-note">
                  1R = dein Stop-Loss-Abstand. Bei $
                  {(accountSize * (riskPercent / 100)).toFixed(0)} Risk/Trade
                  entspricht die P95-DD einem potentiellen Drawdown von $
                  {(
                    accountSize *
                    (riskPercent / 100) *
                    monteCarlo.p95MaxDrawdownR
                  ).toFixed(0)}
                  .
                </p>
              </>
            )}
          </>
        ) : (
          <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
            Zeigt In-Sample vs Out-of-Sample Performance, Overfitting-Warnung
            und Monte-Carlo Drawdown-Verteilung. Je näher OOS an IS, desto mehr
            vertraust du den Rules.
          </p>
        )}
      </div>

      <div className="glass-card live-history-card">
        <div className="live-backtest-header">
          <h3 className="dashboard-section-title">
            Tracked Signals ({symbol})
          </h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {trackedWinRate !== null && (
              <span className="live-muted-note" style={{ margin: 0 }}>
                Live: {closedTracked.length} closed ·{" "}
                {(trackedWinRate * 100).toFixed(0)}% WR · {tracking.openCount}{" "}
                open
              </span>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={tracking.clearAll}
            >
              Clear all
            </button>
          </div>
        </div>
        {tracked.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            Noch keine getrackten Signale. Jeder Signal-Flip wird hier
            aufgezeichnet und automatisch als WIN/LOSS markiert, sobald der
            Preis TP oder SL erreicht.
          </p>
        ) : (
          <table className="live-history-table">
            <thead>
              <tr>
                <th>Opened</th>
                <th>TF</th>
                <th>Action</th>
                <th>Entry</th>
                <th>SL</th>
                <th>TP</th>
                <th>Conf</th>
                <th>Status</th>
                <th>R</th>
              </tr>
            </thead>
            <tbody>
              {[...tracked]
                .reverse()
                .slice(0, 25)
                .map((t) => (
                  <tr key={t.id}>
                    <td>{formatTime(t.openTime)}</td>
                    <td>{t.timeframe}</td>
                    <td>
                      <span className={`live-action-chip ${t.action}`}>
                        {t.action === "long" ? "BUY" : "SELL"}
                      </span>
                    </td>
                    <td>{formatPrice(t.entry)}</td>
                    <td>{formatPrice(t.stopLoss)}</td>
                    <td>{formatPrice(t.takeProfit)}</td>
                    <td>{t.confidence}%</td>
                    <td>
                      <span className={`live-status-chip status-${t.status}`}>
                        {t.status.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      {t.pnlR !== undefined
                        ? `${t.pnlR >= 0 ? "+" : ""}${t.pnlR.toFixed(2)}`
                        : "—"}
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

function BacktestStat({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "profit" | "loss";
}) {
  return (
    <div className="live-indicator-cell">
      <span className="live-indicator-label">{label}</span>
      <span className={`live-indicator-value ${variant ?? ""}`}>{value}</span>
    </div>
  );
}

function BaseStatCell({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "profit" | "loss";
}) {
  return (
    <div className="live-indicator-cell">
      <span className="live-indicator-label">{label}</span>
      <span className={`live-indicator-value ${variant ?? ""}`}>{value}</span>
    </div>
  );
}

function fmtInd(v: number | null): string {
  return v === null ? "—" : formatPrice(v);
}
function fmtNum(v: number | null, digits: number): string {
  return v === null ? "—" : v.toFixed(digits);
}
function pfLabel(pf: number): string {
  return pf === Infinity ? "Inf" : pf.toFixed(2);
}
