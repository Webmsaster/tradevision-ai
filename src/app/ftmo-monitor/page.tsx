"use client";

/**
 * FTMO Bot Live Monitor — reads state from /api/ftmo-state and displays:
 * - Equity / day / status banner
 * - FTMO rule progress bars
 * - Equity curve chart
 * - Live signal preview (what iter231 would decide RIGHT NOW)
 * - Open positions
 * - Recent signals (from signal-log.jsonl)
 * - Recent executions (from executor-log.jsonl)
 *
 * Auto-refreshes every 15s.
 */
import { useEffect, useState } from "react";

interface PreviewResult {
  regime: "BULL" | "BEAR_CHOP";
  activeBotConfig: string;
  signals: Array<{
    assetSymbol: string;
    direction: string;
    entryPrice: number;
    stopPct: number;
    tpPct: number;
    riskFrac: number;
    sizingFactor: number;
    reasons: string[];
  }>;
  skipped: Array<{ asset: string; reason: string }>;
  notes: string[];
  btc: {
    close: number;
    ema10: number;
    ema15: number;
    uptrend: boolean;
    mom24h: number;
  };
  lastBarClose: number | null;
  nextCheckAt: number;
}

interface FtmoState {
  account: {
    equity?: number;
    day?: number;
    raw_equity_usd?: number;
    raw_balance_usd?: number;
    equityAtDayStart?: number;
    updated_at?: string;
    recentPnls?: number[];
  };
  status: { ts?: string; nextCheckInSec?: number };
  pending: {
    signals: Array<{
      assetSymbol: string;
      entryPrice: number;
      direction: string;
      maxHoldHours: number;
    }>;
  };
  executed: {
    executions: Array<{
      signal: { assetSymbol: string };
      result: string;
      ts: string;
      ticket?: number;
      lot?: number;
      actual_entry?: number;
      reason?: string;
      error?: string;
    }>;
  };
  openPos: {
    positions: Array<{
      ticket: number;
      signalAsset: string;
      lot: number;
      entry_price: number;
      opened_at: string;
      max_hold_until: number;
    }>;
  };
  dailyReset: { date?: string; equity_at_day_start_usd?: number };
  controls: { paused: boolean; killRequested: boolean };
  lastCheck: { signalCount?: number; timestamp?: number };
  signalLog: Array<{
    ts: string;
    event: string;
    signalCount?: number;
    newSignalsQueued?: number;
  }>;
  executorLog: Array<{ ts: string; event: string; [k: string]: unknown }>;
  equityHistory?: Array<{ ts: string; equity_usd: number; equity_pct: number }>;
  stats?: {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  };
  drawdown?: { currentDd: number; maxDd: number; peak: number };
  ruleProgress?: {
    dailyLossUsed: number;
    totalLossUsed: number;
    profitTargetProgress: number;
    dailyLossPct: number;
    totalLossPct: number;
    totalGainPct: number;
  };
  stateDir: string;
  generatedAt: string;
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600_000)}h ago`;
}

function fmtPct(v: number | undefined): string {
  if (v === undefined) return "?";
  const pct = (v - 1) * 100;
  return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
}

function fmtUsd(v: number | undefined): string {
  if (v === undefined) return "?";
  return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function FtmoMonitorPage() {
  const [state, setState] = useState<FtmoState | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchState() {
      try {
        const resp = await fetch("/api/ftmo-state", { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as FtmoState;
        if (!cancelled) {
          setState(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    async function fetchPreview() {
      if (cancelled) return;
      setPreviewLoading(true);
      try {
        const resp = await fetch("/api/ftmo-preview", { cache: "no-store" });
        if (resp.ok) {
          const data = (await resp.json()) as PreviewResult;
          if (!cancelled) setPreview(data);
        }
      } catch {
        // ignore preview errors
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }
    fetchState();
    fetchPreview();
    const stateTimer = setInterval(fetchState, 15_000);
    const previewTimer = setInterval(fetchPreview, 60_000); // 1min (server caches 30s)
    return () => {
      cancelled = true;
      clearInterval(stateTimer);
      clearInterval(previewTimer);
    };
  }, [refreshTick]);

  if (error && !state) {
    return (
      <div className="p-8 text-txt">
        <h1 className="text-2xl font-bold mb-4">FTMO Monitor</h1>
        <div className="bg-loss/20 border border-loss p-4 rounded">
          Error: {error}
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="p-8 text-txt">
        <h1 className="text-2xl font-bold mb-4">FTMO Monitor</h1>
        <div>Loading…</div>
      </div>
    );
  }

  const equity = state.account.equity;
  const equityPct = equity !== undefined ? (equity - 1) * 100 : 0;
  const isGreen = equityPct >= 0;
  const dailyStart = state.account.equityAtDayStart ?? 1;
  const dailyPct =
    equity !== undefined ? ((equity - dailyStart) / dailyStart) * 100 : 0;

  const serviceOnline =
    state.status.ts &&
    Date.now() - new Date(state.status.ts).getTime() < 120_000;

  return (
    <div className="p-6 max-w-6xl mx-auto text-txt space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">🤖 FTMO Bot Monitor</h1>
        <button
          onClick={() => setRefreshTick((t) => t + 1)}
          className="px-3 py-1.5 bg-surface hover:bg-surface/70 border border-surface rounded text-sm"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Status banner */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card
          label="Equity"
          value={fmtPct(equity)}
          sub={fmtUsd(state.account.raw_equity_usd)}
          tone={isGreen ? "profit" : "loss"}
        />
        <Card
          label="Today"
          value={(dailyPct >= 0 ? "+" : "") + dailyPct.toFixed(2) + "%"}
          sub={state.dailyReset.date ?? "?"}
          tone={dailyPct >= 0 ? "profit" : "loss"}
        />
        <Card
          label="Day"
          value={`${(state.account.day ?? 0) + 1} / 30`}
          sub={`last check ${timeAgo(state.lastCheck.timestamp ? new Date(state.lastCheck.timestamp).toISOString() : undefined)}`}
        />
        <Card
          label="Status"
          value={
            state.controls.paused
              ? "⏸ PAUSED"
              : serviceOnline
                ? "▶️ LIVE"
                : "⚠️ STALE"
          }
          sub={`heartbeat ${timeAgo(state.status.ts)}`}
          tone={
            state.controls.paused
              ? "neutral"
              : serviceOnline
                ? "profit"
                : "loss"
          }
        />
      </div>

      {/* FTMO Rule Progress */}
      {state.ruleProgress && (
        <section>
          <h2 className="text-xl font-semibold mb-2">🎯 FTMO Rules</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <RuleBar
              label="Profit Target (+10%)"
              pct={state.ruleProgress.profitTargetProgress}
              displayValue={`${(state.ruleProgress.totalGainPct * 100).toFixed(2)}%`}
              tone="profit"
              inverse
            />
            <RuleBar
              label="Daily Loss (-5%)"
              pct={state.ruleProgress.dailyLossUsed}
              displayValue={`${(state.ruleProgress.dailyLossPct * 100).toFixed(2)}%`}
              tone="daily"
            />
            <RuleBar
              label="Total Loss (-10%)"
              pct={state.ruleProgress.totalLossUsed}
              displayValue={`${(state.ruleProgress.totalLossPct * 100).toFixed(2)}%`}
              tone="total"
            />
          </div>
        </section>
      )}

      {/* Live signal preview */}
      <SignalPreviewCard preview={preview} loading={previewLoading} />

      {/* Equity chart */}
      {state.equityHistory && state.equityHistory.length > 1 && (
        <section>
          <h2 className="text-xl font-semibold mb-2">📈 Equity Curve</h2>
          <EquityChart history={state.equityHistory} />
          {state.drawdown && (
            <div className="text-xs text-txt/60 mt-2">
              Current DD:{" "}
              <span
                className={
                  state.drawdown.currentDd < -0.02 ? "text-loss" : "text-txt"
                }
              >
                {(state.drawdown.currentDd * 100).toFixed(2)}%
              </span>
              {" · "}Max DD:{" "}
              <span className="text-loss">
                {(state.drawdown.maxDd * 100).toFixed(2)}%
              </span>
              {" · "}Peak: ${state.drawdown.peak.toLocaleString()}
            </div>
          )}
        </section>
      )}

      {/* Trade statistics */}
      {state.stats && state.stats.total > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-2">
            📊 Trade Statistics ({state.stats.total} closed)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card
              label="Win Rate"
              value={`${(state.stats.winRate * 100).toFixed(1)}%`}
              sub={`${state.stats.wins}W / ${state.stats.losses}L`}
              tone={state.stats.winRate > 0.5 ? "profit" : "loss"}
            />
            <Card
              label="Profit Factor"
              value={state.stats.profitFactor.toFixed(2)}
              sub={state.stats.profitFactor > 1 ? "profitable" : "losing"}
              tone={state.stats.profitFactor > 1 ? "profit" : "loss"}
            />
            <Card
              label="Avg Win"
              value={`$${state.stats.avgWin.toFixed(2)}`}
              sub="per winning trade"
              tone="profit"
            />
            <Card
              label="Avg Loss"
              value={`$${state.stats.avgLoss.toFixed(2)}`}
              sub="per losing trade"
              tone="loss"
            />
          </div>
        </section>
      )}

      {/* Open positions */}
      <section>
        <h2 className="text-xl font-semibold mb-2">
          📈 Open Positions ({state.openPos.positions.length})
        </h2>
        {state.openPos.positions.length === 0 ? (
          <div className="text-txt/60 text-sm">No open positions.</div>
        ) : (
          <div className="bg-surface rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-left bg-surface/50">
                <tr>
                  <th className="p-2">Asset</th>
                  <th className="p-2">Ticket</th>
                  <th className="p-2">Lot</th>
                  <th className="p-2">Entry</th>
                  <th className="p-2">Opened</th>
                  <th className="p-2">Hold-left</th>
                </tr>
              </thead>
              <tbody>
                {state.openPos.positions.map((p) => {
                  const holdLeft = Math.max(
                    0,
                    Math.round((p.max_hold_until - Date.now()) / 60000),
                  );
                  return (
                    <tr key={p.ticket} className="border-t border-surface/30">
                      <td className="p-2 font-mono">{p.signalAsset}</td>
                      <td className="p-2 font-mono">{p.ticket}</td>
                      <td className="p-2">{p.lot}</td>
                      <td className="p-2">${p.entry_price.toFixed(4)}</td>
                      <td className="p-2 text-txt/70">
                        {timeAgo(p.opened_at)}
                      </td>
                      <td className="p-2 text-txt/70">{holdLeft}m</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending signals */}
      {state.pending.signals.length > 0 && (
        <section>
          <h2 className="text-xl font-semibold mb-2">
            ⏳ Pending Signals (awaiting executor)
          </h2>
          <div className="bg-surface rounded p-3 text-sm font-mono">
            {state.pending.signals.map((s, i) => (
              <div key={i}>
                {s.assetSymbol} {s.direction.toUpperCase()} @ $
                {s.entryPrice.toFixed(4)} · max hold {s.maxHoldHours}h
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent executions */}
      <section>
        <h2 className="text-xl font-semibold mb-2">
          📝 Recent Executions ({state.executed.executions.length})
        </h2>
        <div className="bg-surface rounded overflow-hidden text-sm">
          <table className="w-full">
            <thead className="text-left bg-surface/50">
              <tr>
                <th className="p-2">When</th>
                <th className="p-2">Asset</th>
                <th className="p-2">Result</th>
                <th className="p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {[...state.executed.executions]
                .slice(-15)
                .reverse()
                .map((ex, i) => (
                  <tr key={i} className="border-t border-surface/30">
                    <td className="p-2 text-txt/70">{timeAgo(ex.ts)}</td>
                    <td className="p-2 font-mono">{ex.signal.assetSymbol}</td>
                    <td className="p-2">
                      <span
                        className={
                          ex.result === "placed"
                            ? "text-profit"
                            : ex.result === "blocked"
                              ? "text-yellow-400"
                              : "text-loss"
                        }
                      >
                        {ex.result}
                      </span>
                    </td>
                    <td className="p-2 text-txt/70 font-mono text-xs">
                      {ex.result === "placed"
                        ? `#${ex.ticket} lot=${ex.lot} @ $${ex.actual_entry?.toFixed(4)}`
                        : ex.result === "blocked"
                          ? ex.reason
                          : ex.error}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent events */}
      <section>
        <h2 className="text-xl font-semibold mb-2">📜 Recent Events</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LogPanel
            title="Signal service"
            entries={state.signalLog.slice(-15).reverse()}
          />
          <LogPanel
            title="Executor"
            entries={state.executorLog.slice(-15).reverse()}
          />
        </div>
      </section>

      <div className="text-xs text-txt/50 pt-4">
        state dir: <code>{state.stateDir}</code> · generated{" "}
        {timeAgo(state.generatedAt)} · auto-refresh every 15s
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "profit" | "loss" | "neutral";
}) {
  const colorClass =
    tone === "profit"
      ? "text-profit"
      : tone === "loss"
        ? "text-loss"
        : "text-txt";
  return (
    <div className="bg-surface rounded p-4">
      <div className="text-xs text-txt/60 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      <div className="text-xs text-txt/60 mt-1">{sub}</div>
    </div>
  );
}

function SignalPreviewCard({
  preview,
  loading,
}: {
  preview: PreviewResult | null;
  loading: boolean;
}) {
  if (!preview) {
    return (
      <section>
        <h2 className="text-xl font-semibold mb-2">🔮 Live Signal Preview</h2>
        <div className="bg-surface rounded p-4 text-txt/60 text-sm">
          {loading ? "Checking live market data…" : "No preview available yet."}
        </div>
      </section>
    );
  }

  const secondsToCheck = Math.max(
    0,
    Math.round((preview.nextCheckAt - Date.now()) / 1000),
  );
  const mmss = `${Math.floor(secondsToCheck / 60)}:${String(secondsToCheck % 60).padStart(2, "0")}`;
  const hasSignal = preview.signals.length > 0;

  return (
    <section>
      <h2 className="text-xl font-semibold mb-2">
        🔮 Live Signal Preview
        <span className="text-sm font-normal text-txt/60 ml-3">
          Regime:{" "}
          <span
            className={preview.regime === "BULL" ? "text-profit" : "text-txt"}
          >
            {preview.regime}
          </span>
          {" · "}Bot: {preview.activeBotConfig}
          {" · "}Next check in {mmss}
        </span>
      </h2>
      <div className="bg-surface rounded p-4 space-y-3">
        <div className="text-xs text-txt/70 font-mono">
          BTC: ${preview.btc.close.toFixed(0)} · EMA10 $
          {preview.btc.ema10.toFixed(0)} · EMA15 ${preview.btc.ema15.toFixed(0)}{" "}
          · 24h {(preview.btc.mom24h * 100).toFixed(2)}%
        </div>

        {hasSignal ? (
          <div className="space-y-2">
            <div className="text-profit font-semibold">
              🚨 {preview.signals.length} LIVE SIGNAL
              {preview.signals.length > 1 ? "S" : ""}
            </div>
            {preview.signals.map((s, i) => (
              <div
                key={i}
                className="border border-profit/30 bg-profit/5 rounded p-2 text-sm"
              >
                <div className="font-mono">
                  <span className="font-bold">{s.assetSymbol}</span> ·{" "}
                  {s.direction.toUpperCase()} @ ${s.entryPrice.toFixed(4)}
                </div>
                <div className="text-xs text-txt/70">
                  Stop {(s.stopPct * 100).toFixed(1)}% · TP{" "}
                  {(s.tpPct * 100).toFixed(1)}% · Risk{" "}
                  {(s.riskFrac * 100).toFixed(2)}% · factor{" "}
                  {s.sizingFactor.toFixed(2)}×
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-txt/70 text-sm">⏸ No signal right now</div>
        )}

        {preview.skipped.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-txt/60 hover:text-txt">
              Why no signal for {preview.skipped.length} asset(s)?
            </summary>
            <div className="mt-2 space-y-1 pl-3">
              {preview.skipped.map((s, i) => (
                <div key={i} className="font-mono">
                  <span className="text-txt/50">•</span>{" "}
                  <span className="font-bold">{s.asset}</span>: {s.reason}
                </div>
              ))}
            </div>
          </details>
        )}

        {preview.notes.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-txt/60 hover:text-txt">
              Detector notes ({preview.notes.length})
            </summary>
            <div className="mt-2 space-y-1 pl-3 font-mono text-txt/70">
              {preview.notes.map((n, i) => (
                <div key={i}>• {n}</div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function RuleBar({
  label,
  pct,
  displayValue,
  tone,
  inverse,
}: {
  label: string;
  pct: number; // 0..1 (1 = at limit)
  displayValue: string;
  tone: "profit" | "daily" | "total";
  inverse?: boolean; // if true, filled bar = good (profit target)
}) {
  const clamped = Math.max(0, Math.min(1, pct));
  // Color: green when safe (low), yellow at 60%, red at 85%+
  const barColor = inverse
    ? clamped > 0.85
      ? "bg-profit"
      : clamped > 0.5
        ? "bg-yellow-500"
        : "bg-surface/70"
    : clamped > 0.85
      ? "bg-loss"
      : clamped > 0.5
        ? "bg-yellow-500"
        : "bg-profit";
  return (
    <div className="bg-surface rounded p-4">
      <div className="text-xs text-txt/60 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-xl font-bold mb-2">{displayValue}</div>
      <div className="h-2 bg-surface/50 rounded overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500`}
          style={{ width: `${(clamped * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="text-xs text-txt/60 mt-1">
        {inverse
          ? `${(clamped * 100).toFixed(0)}% to target`
          : `${(clamped * 100).toFixed(0)}% of limit used`}
      </div>
    </div>
  );
}

function EquityChart({
  history,
}: {
  history: Array<{ ts: string; equity_usd: number }>;
}) {
  if (history.length < 2) return null;
  const values = history.map((s) => s.equity_usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 1000;
  const h = 160;
  const points = history
    .map((s, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((s.equity_usd - min) / range) * (h - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = history[0].equity_usd;
  const last = history[history.length - 1].equity_usd;
  const isUp = last >= first;
  const stroke = isUp ? "#10b981" : "#ef4444";
  const fill = isUp ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)";
  const firstX = 0;
  const lastX = w;
  const areaPoints = `${firstX},${h} ${points} ${lastX},${h}`;
  return (
    <div className="bg-surface rounded p-4">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        preserveAspectRatio="none"
      >
        <polygon points={areaPoints} fill={fill} />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-xs text-txt/60 mt-2">
        <span>
          {new Date(history[0].ts).toISOString().slice(0, 16).replace("T", " ")}
          Z
        </span>
        <span>
          ${min.toLocaleString()} – ${max.toLocaleString()}
        </span>
        <span>
          {new Date(history[history.length - 1].ts)
            .toISOString()
            .slice(0, 16)
            .replace("T", " ")}
          Z
        </span>
      </div>
    </div>
  );
}

function LogPanel({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ ts: string; event: string; [k: string]: unknown }>;
}) {
  return (
    <div className="bg-surface rounded overflow-hidden">
      <div className="text-sm font-semibold p-2 bg-surface/50">{title}</div>
      <div className="max-h-80 overflow-y-auto text-xs font-mono">
        {entries.length === 0 ? (
          <div className="p-2 text-txt/50">No events yet.</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="border-t border-surface/30 p-2">
              <div className="text-txt/50">{timeAgo(e.ts)}</div>
              <div>{e.event}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
