"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

// R-Perf: lazy-load recharts surface (~120KB) — paper log is rarely the
// landing page and the chart is below-the-fold.
const PaperEquityChart = dynamic(
  () =>
    import("./_PaperEquityChart").then((m) => ({
      default: m.PaperEquityChart,
    })),
  { ssr: false, loading: () => null },
);

type PaperStrategy = "hf-daytrading" | "hi-wr-1h" | "vol-spike-1h";

interface PaperPosition {
  id: string;
  strategy: PaperStrategy;
  symbol: string;
  direction: "long" | "short";
  entry: number;
  tp1?: number;
  tp2?: number;
  stop: number;
  entryTime: string;
  holdUntil: string;
  tp1Hit: boolean;
  legs: 1 | 2;
}

interface ClosedTrade {
  id: string;
  strategy: PaperStrategy;
  symbol: string;
  direction: "long" | "short";
  entry: number;
  exit: number;
  entryTime: string;
  exitTime: string;
  grossPnlPct: number;
  netPnlPct: number;
  exitReason: string;
}

interface PaperState {
  openPositions: PaperPosition[];
  closedTrades: ClosedTrade[];
  lastTickAt: string | null;
  error: string | null;
}

// Backtest reference stats (matches STRATEGY_EDGE_STATS)
const BACKTEST_WR: Record<PaperStrategy, number> = {
  "hf-daytrading": 0.85,
  "hi-wr-1h": 0.718,
  "vol-spike-1h": 0.5,
};

function daysAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86400_000;
}

function rollingWr(
  trades: ClosedTrade[],
  strategy: PaperStrategy,
  windowDays: number,
): { wr: number; n: number } {
  const recent = trades.filter(
    (t) => t.strategy === strategy && daysAgo(t.exitTime) <= windowDays,
  );
  if (recent.length === 0) return { wr: 0, n: 0 };
  const wins = recent.filter((t) => t.netPnlPct > 0).length;
  return { wr: wins / recent.length, n: recent.length };
}

function buildEquityCurve(
  trades: ClosedTrade[],
  initialCapital = 10_000,
): Array<{ idx: number; time: string; equity: number; cumReturnPct: number }> {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );
  let equity = initialCapital;
  const curve: Array<{
    idx: number;
    time: string;
    equity: number;
    cumReturnPct: number;
  }> = [{ idx: 0, time: "start", equity, cumReturnPct: 0 }];
  sorted.forEach((t, i) => {
    // Assume 25% notional per trade (Kelly-cap default)
    const notional = equity * 0.25;
    equity += notional * t.netPnlPct;
    curve.push({
      idx: i + 1,
      time: t.exitTime.slice(0, 10),
      equity,
      cumReturnPct: (equity / initialCapital - 1) * 100,
    });
  });
  return curve;
}

export default function PaperLogPage() {
  const [state, setState] = useState<PaperState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/paper-state", { cache: "no-store" });
      const data = (await r.json()) as PaperState;
      setState(data);
    } catch (err) {
      setState({
        openPositions: [],
        closedTrades: [],
        lastTickAt: null,
        error: (err as Error).message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, []);

  if (loading && !state) {
    return <main style={{ padding: 24 }}>Loading paper state…</main>;
  }
  if (!state) return null;

  const closed = state.closedTrades ?? [];
  const open = state.openPositions ?? [];

  // Aggregate stats
  const wins = closed.filter((t) => t.netPnlPct > 0).length;
  const wr = closed.length > 0 ? wins / closed.length : 0;
  const totalRet = closed.reduce((acc, t) => acc * (1 + t.netPnlPct), 1) - 1;

  const curve = buildEquityCurve(closed);
  const strategies: PaperStrategy[] = [
    "hf-daytrading",
    "hi-wr-1h",
    "vol-spike-1h",
  ];

  return (
    <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 16,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Paper-Trade Log</h1>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Last tick:{" "}
          {state.lastTickAt ? state.lastTickAt.slice(0, 19) + " UTC" : "—"}
          <button
            onClick={refresh}
            style={{
              marginLeft: 12,
              padding: "4px 10px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {state.error && (
        <div
          style={{
            padding: 12,
            background: "var(--surface-2, #2a2a2a)",
            color: "var(--loss, #ef4444)",
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {state.error}
        </div>
      )}

      {/* Top-line stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <StatCard label="Closed trades" value={closed.length.toString()} />
        <StatCard
          label="Win rate"
          value={`${(wr * 100).toFixed(1)}%`}
          tone={wr >= 0.75 ? "good" : wr >= 0.5 ? "neutral" : "bad"}
        />
        <StatCard
          label="Cumulative return"
          value={`${totalRet >= 0 ? "+" : ""}${(totalRet * 100).toFixed(2)}%`}
          tone={totalRet >= 0 ? "good" : "bad"}
        />
        <StatCard label="Open positions" value={open.length.toString()} />
      </div>

      {/* Per-strategy rolling WR */}
      <h2 style={{ fontSize: 16, marginTop: 24, marginBottom: 8 }}>
        Per-Strategy: 7-day rolling WR vs Backtest
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto auto auto auto auto 1fr",
          gap: "4px 14px",
          fontSize: 12,
          marginBottom: 24,
          alignItems: "baseline",
        }}
      >
        <strong>Strategy</strong>
        <strong>All n</strong>
        <strong>All WR</strong>
        <strong>7d n</strong>
        <strong>7d WR</strong>
        <strong>Gap vs backtest</strong>
        {strategies.map((s) => {
          const all = closed.filter((t) => t.strategy === s);
          const allN = all.length;
          const allWr =
            allN > 0 ? all.filter((t) => t.netPnlPct > 0).length / allN : 0;
          const rolling = rollingWr(closed, s, 7);
          const bt = BACKTEST_WR[s];
          const gap = rolling.n > 0 ? (rolling.wr - bt) * 100 : null;
          const gapColor =
            gap === null
              ? "var(--text-secondary)"
              : gap < -10
                ? "var(--loss, #ef4444)"
                : gap < -5
                  ? "#e2a000"
                  : "var(--profit, #22c55e)";
          return (
            <div key={s} style={{ display: "contents" }}>
              <span>{s}</span>
              <span>{allN}</span>
              <span>{allN > 0 ? `${(allWr * 100).toFixed(1)}%` : "—"}</span>
              <span>{rolling.n}</span>
              <span>
                {rolling.n > 0 ? `${(rolling.wr * 100).toFixed(1)}%` : "—"}
              </span>
              <span style={{ color: gapColor }}>
                {gap === null
                  ? "—"
                  : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp (bt ${(bt * 100).toFixed(0)}%)`}
              </span>
            </div>
          );
        })}
      </div>

      {/* Equity curve */}
      {curve.length > 1 && (
        <>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>
            Equity Curve ($10k initial, 25% notional per trade)
          </h2>
          <div
            style={{
              height: 280,
              background: "var(--surface, #1a1a1a)",
              padding: 12,
              borderRadius: 6,
              marginBottom: 24,
            }}
          >
            <PaperEquityChart data={curve} />
          </div>
        </>
      )}

      {/* Open positions */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Open Positions</h2>
      {open.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          No open positions.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto auto auto auto auto auto auto",
            gap: "4px 14px",
            fontSize: 12,
            marginBottom: 24,
            alignItems: "baseline",
          }}
        >
          <strong>Strategy</strong>
          <strong>Symbol</strong>
          <strong>Dir</strong>
          <strong>Entry</strong>
          <strong>TP1/TP2</strong>
          <strong>Stop</strong>
          <strong>Hold until</strong>
          {open.map((p) => (
            <div key={p.id} style={{ display: "contents" }}>
              <span>{p.strategy}</span>
              <span>{p.symbol.replace("USDT", "")}</span>
              <span
                style={{
                  color:
                    p.direction === "long"
                      ? "var(--profit, #22c55e)"
                      : "var(--loss, #ef4444)",
                  fontWeight: 600,
                }}
              >
                {p.direction.toUpperCase()}
              </span>
              <span style={{ fontFamily: "monospace" }}>
                ${p.entry.toFixed(4)}
              </span>
              <span style={{ fontFamily: "monospace" }}>
                {p.tp1 ? `$${p.tp1.toFixed(4)}` : "—"}/
                {p.tp2 ? `$${p.tp2.toFixed(4)}` : "—"}
              </span>
              <span style={{ fontFamily: "monospace" }}>
                ${p.stop.toFixed(4)}
              </span>
              <span>{p.holdUntil.slice(11, 16)} UTC</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent closed trades */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Recent 20 Closed</h2>
      {closed.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          No closed trades yet.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto auto auto auto auto auto",
            gap: "4px 14px",
            fontSize: 12,
            alignItems: "baseline",
          }}
        >
          <strong>Exit time</strong>
          <strong>Strategy</strong>
          <strong>Symbol</strong>
          <strong>Dir</strong>
          <strong>Reason</strong>
          <strong>Net %</strong>
          {[...closed]
            .slice(-20)
            .reverse()
            .map((t) => {
              const pnl = t.netPnlPct * 100;
              return (
                <div key={t.id} style={{ display: "contents" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>
                    {t.exitTime.slice(0, 16)}
                  </span>
                  <span>{t.strategy}</span>
                  <span>{t.symbol.replace("USDT", "")}</span>
                  <span>{t.direction}</span>
                  <span>{t.exitReason}</span>
                  <span
                    style={{
                      color:
                        pnl > 0
                          ? "var(--profit, #22c55e)"
                          : pnl < 0
                            ? "var(--loss, #ef4444)"
                            : undefined,
                      fontWeight: 600,
                      fontFamily: "monospace",
                    }}
                  >
                    {pnl >= 0 ? "+" : ""}
                    {pnl.toFixed(2)}%
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </main>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const color =
    tone === "good"
      ? "var(--profit, #22c55e)"
      : tone === "bad"
        ? "var(--loss, #ef4444)"
        : undefined;
  return (
    <div
      style={{
        background: "var(--surface, #1a1a1a)",
        padding: "12px 16px",
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}
