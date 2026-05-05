"use client";

/**
 * /dashboard/drift — Backtest vs Live Drift Dashboard for the FTMO bot.
 *
 * Pulls JSON from /api/drift-data every 30s and visualises:
 *   1. Header chip (challenge name, days elapsed/remaining, pass status)
 *   2. Equity card (current vs day-start vs peak vs DL/TL caps)
 *   3. Equity chart (live curve overlaid on backtest p10/p50/p90 band)
 *   4. Drift indicator (live equity ± vs backtest median, large + colored)
 *   5. Recent events log (last 20 from executor-log.jsonl, collapsible)
 *   6. Active positions table
 *   7. Daily PnL bar chart (last 14 days)
 *   8. Health checks (heartbeat, MT5, Telegram, signal feed)
 *
 * Multi-account: pass ?ftmo_tf=<slug> to point at a different state-dir.
 * Read-only — never mutates state files.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/Skeleton";

// Round 56 fix #6: defer the heavy recharts surface (~120KB) until after
// the page frame is interactive. The skeleton matches the chart
// dimensions so the layout shift is near-zero.
const EquityChartSection = dynamic(
  () =>
    import("./_EquityChartSection").then((m) => ({
      default: m.EquityChartSection,
    })),
  {
    ssr: false,
    loading: () => (
      <section className="bg-surface rounded-xl p-5">
        <div className="h-[320px] sm:h-[400px] flex items-center justify-center">
          <Skeleton variant="card" />
        </div>
      </section>
    ),
  },
);
const DailyPnlSection = dynamic(
  () =>
    import("./_DailyPnlSection").then((m) => ({ default: m.DailyPnlSection })),
  {
    ssr: false,
    loading: () => (
      <section className="bg-surface rounded-xl p-5">
        <div className="h-[220px] flex items-center justify-center">
          <Skeleton variant="card" />
        </div>
      </section>
    ),
  },
);

// ---------------------------------------------------------------------------
// Types — mirror /api/drift-data response shape
// ---------------------------------------------------------------------------

interface BacktestPoint {
  day: number;
  median: number;
  p10: number;
  p90: number;
}
interface EquityPoint {
  ts: string;
  day: number;
  equityUsd: number;
  equityPct: number;
}
interface DailyPnlBar {
  date: string;
  pnlUsd: number;
  pnlPct: number;
  equityUsd: number;
}
interface DriftResult {
  liveEquityPct: number;
  expectedMedianPct: number;
  driftPct: number;
  band: BacktestPoint;
  inBand: boolean;
}
interface Position {
  ticket: number;
  signalAsset: string;
  sourceSymbol?: string;
  direction: "long" | "short";
  lot: number;
  entry_price: number;
  stop_price: number;
  tp_price: number;
  opened_at: string;
  ageMin: number;
}
interface ExecutorEvent {
  ts: string;
  event: string;
  [k: string]: unknown;
}
interface NewsMarker {
  ts: string;
  label: string;
}
interface DriftData {
  meta: {
    backtestRef: {
      name: string;
      passRatePct: number;
      medianPassDay: number;
      p90PassDay: number;
      profitTargetPct: number;
      dailyLossCapPct: number;
      totalLossCapPct: number;
      maxChallengeDays: number;
    };
    stateDir: string;
    availableTfSlugs: string[];
    currentTfSlug: string;
    startBalanceUsd: number;
    generatedAt: string;
  };
  header: {
    challengeName: string;
    liveDay: number;
    daysElapsed: number;
    daysRemaining: number;
    passStatus: "passed" | "active" | "failed";
    botPaused: boolean;
    killRequested: boolean;
  };
  equity: {
    currentUsd: number;
    currentPct: number;
    dayStartUsd: number;
    dailyPnlPct: number;
    totalPnlPct: number;
    peakUsd: number;
    peakAt: string | null;
    dlCapPct: number;
    tlCapPct: number;
    targetPct: number;
  };
  drift: DriftResult | null;
  ruleProgress: {
    profitTargetProgress: number;
    dailyLossUsed: number;
    totalLossUsed: number;
    drawdownVsPeakPct: number;
  };
  equityHistory: EquityPoint[];
  backtestBand: BacktestPoint[];
  dailyPnlBars: DailyPnlBar[];
  newsMarkers: NewsMarker[];
  recentEvents: ExecutorEvent[];
  positions: Position[];
  pendingCount: number;
  health: {
    botHeartbeatOk: boolean;
    botHeartbeatAgeSec: number | null;
    mt5Connected: boolean;
    telegramOk: boolean;
    signalFeedFresh: boolean;
    signalFeedAgeMin: number | null;
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtPct(v: number, sign = true): string {
  const s = v.toFixed(2);
  return (sign && v >= 0 ? "+" : "") + s + "%";
}
function fmtUsd(v: number): string {
  return "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}
function fmtTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DriftDashboardPage() {
  // useSearchParams() forces client-side bailout — Next requires it under
  // a Suspense boundary so the surrounding skeleton can be statically
  // pre-rendered.
  return (
    <Suspense
      fallback={
        <div className="p-6 max-w-7xl mx-auto text-txt">
          <h1 className="text-2xl font-bold mb-4">Drift Dashboard</h1>
          <div>Loading…</div>
        </div>
      }
    >
      <DriftDashboardInner />
    </Suspense>
  );
}

function DriftDashboardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tfSlug = searchParams.get("ftmo_tf") ?? "";

  const [data, setData] = useState<DriftData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number>(0);
  const [eventsOpen, setEventsOpen] = useState(false);

  const fetchUrl = useMemo(() => {
    const qs = tfSlug ? `?ftmo_tf=${encodeURIComponent(tfSlug)}` : "";
    return `/api/drift-data${qs}`;
  }, [tfSlug]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(fetchUrl, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as DriftData;
      setData(json);
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fetchUrl]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const onTfChange = (newSlug: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (newSlug) params.set("ftmo_tf", newSlug);
    else params.delete("ftmo_tf");
    const qs = params.toString();
    router.replace(`/dashboard/drift${qs ? "?" + qs : ""}`);
  };

  if (error && !data) {
    return (
      <div className="p-6 max-w-7xl mx-auto text-txt">
        <h1 className="text-2xl font-bold mb-4">Drift Dashboard</h1>
        <div className="bg-loss/20 border border-loss p-4 rounded">
          Error: {error}
          <div className="text-xs mt-2 opacity-70">
            Tip: enable the dashboard with{" "}
            <code className="font-mono">FTMO_MONITOR_ENABLED=1</code> when
            starting Next.
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 max-w-7xl mx-auto text-txt">
        <h1 className="text-2xl font-bold mb-4">Drift Dashboard</h1>
        <div>Loading…</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto text-txt space-y-6">
      <Header
        data={data}
        tfSlug={tfSlug}
        onTfChange={onTfChange}
        onRefresh={refresh}
        loadedAt={loadedAt}
      />

      <DriftIndicator data={data} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EquityCard data={data} />
        <HealthCard data={data} />
      </div>

      <EquityChartSection
        data={{
          equityHistory: data.equityHistory,
          backtestBand: data.backtestBand,
          newsMarkers: data.newsMarkers,
          meta: { backtestRef: data.meta.backtestRef },
          equity: {
            targetPct: data.equity.targetPct,
            tlCapPct: data.equity.tlCapPct,
            dlCapPct: data.equity.dlCapPct,
          },
        }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DailyPnlSection bars={data.dailyPnlBars} />
        <PositionsTable data={data} />
      </div>

      <EventsLog data={data} open={eventsOpen} onToggle={setEventsOpen} />

      <footer className="text-xs text-txt/50 pt-4 border-t border-surface/40">
        State dir: <code>{data.meta.stateDir}</code> · Backtest reference:{" "}
        <code>{data.meta.backtestRef.name}</code> (
        {data.meta.backtestRef.passRatePct}% pass · median{" "}
        {data.meta.backtestRef.medianPassDay}d · p90{" "}
        {data.meta.backtestRef.p90PassDay}d) · refresh every 30s · generated{" "}
        {fmtTimeAgo(data.meta.generatedAt)}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header (challenge name, days, pass status, TF picker)
// ---------------------------------------------------------------------------

function Header({
  data,
  tfSlug,
  onTfChange,
  onRefresh,
  loadedAt,
}: {
  data: DriftData;
  tfSlug: string;
  onTfChange: (s: string) => void;
  onRefresh: () => void;
  loadedAt: number;
}) {
  const status = data.header.passStatus;
  const statusColor =
    status === "passed"
      ? "bg-profit text-bg"
      : status === "failed"
        ? "bg-loss text-bg"
        : "bg-yellow-500/30 text-yellow-200 border border-yellow-500/50";
  const statusLabel =
    status === "passed" ? "PASSED" : status === "failed" ? "FAILED" : "ACTIVE";

  return (
    <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-surface/40">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl sm:text-3xl font-bold">Drift Dashboard</h1>
        <span
          className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ${statusColor}`}
        >
          {statusLabel}
        </span>
        {data.header.botPaused && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-200 border border-yellow-500/40">
            ⏸ PAUSED
          </span>
        )}
        {data.header.killRequested && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-loss/30 text-loss border border-loss/50">
            ⚠ KILL REQUESTED
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <div className="text-txt/80">
          Day{" "}
          <span className="font-bold text-txt">{data.header.daysElapsed}</span>{" "}
          / {data.meta.backtestRef.maxChallengeDays} ·{" "}
          <span className="text-txt/60">
            {data.header.daysRemaining}d remaining
          </span>
        </div>
        <select
          value={tfSlug}
          onChange={(e) => onTfChange(e.target.value)}
          aria-label="FTMO state directory"
          className="bg-surface border border-surface/70 rounded px-2 py-1 text-xs"
        >
          <option value="">(default ftmo-state)</option>
          {data.meta.availableTfSlugs
            .filter((s) => s !== "")
            .map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          {/* Make sure currently-selected slug is present even if not discovered */}
          {tfSlug && !data.meta.availableTfSlugs.includes(tfSlug) && (
            <option value={tfSlug}>{tfSlug} (manual)</option>
          )}
        </select>
        <button
          onClick={onRefresh}
          className="px-2 py-1 bg-surface hover:bg-surface/70 border border-surface/70 rounded text-xs"
        >
          ↻ Refresh
        </button>
        <span className="text-xs text-txt/50">
          {loadedAt ? new Date(loadedAt).toLocaleTimeString() : "—"}
        </span>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Drift indicator — single hero number
// ---------------------------------------------------------------------------

function DriftIndicator({ data }: { data: DriftData }) {
  if (!data.drift) {
    return (
      <section className="bg-surface rounded-xl p-6 text-center">
        <div className="text-xs text-txt/50 uppercase tracking-wide">
          Drift vs Backtest
        </div>
        <div className="text-3xl font-bold mt-2">—</div>
        <div className="text-xs text-txt/50">Waiting for live equity data</div>
      </section>
    );
  }
  const d = data.drift.driftPct;
  const direction = d >= 0 ? "above" : "below";
  const tone =
    Math.abs(d) < 1
      ? "text-txt"
      : d > 0
        ? "text-profit"
        : data.drift.inBand
          ? "text-yellow-400"
          : "text-loss";
  const inBandTag = data.drift.inBand
    ? "within p10–p90 band"
    : d > 0
      ? "above p90 band — overperforming"
      : "below p10 band — underperforming";
  return (
    <section className="bg-surface rounded-xl p-6 text-center">
      <div className="text-xs text-txt/60 uppercase tracking-wide">
        Live equity vs Backtest median (day {data.drift.band.day})
      </div>
      <div className={`text-4xl sm:text-5xl font-extrabold mt-2 ${tone}`}>
        {fmtPct(d)} {direction}
      </div>
      <div className="text-sm text-txt/70 mt-2">
        Live:{" "}
        <span className="font-mono">{fmtPct(data.drift.liveEquityPct)}</span> ·
        Median:{" "}
        <span className="font-mono">
          {fmtPct(data.drift.expectedMedianPct)}
        </span>{" "}
        · Band:{" "}
        <span className="font-mono">
          [{fmtPct(data.drift.band.p10)} … {fmtPct(data.drift.band.p90)}]
        </span>
      </div>
      <div
        className={`text-xs mt-2 ${data.drift.inBand ? "text-txt/60" : "text-yellow-400"}`}
      >
        {inBandTag}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Equity card — current/day-start/peak vs DL/TL caps
// ---------------------------------------------------------------------------

function EquityCard({ data }: { data: DriftData }) {
  const e = data.equity;
  const dailyTone = e.dailyPnlPct >= 0 ? "text-profit" : "text-loss";
  const totalTone = e.totalPnlPct >= 0 ? "text-profit" : "text-loss";
  const dlBuffer = e.dailyPnlPct - e.dlCapPct; // positive = safe
  const tlBuffer = e.totalPnlPct - e.tlCapPct;
  const dlTone =
    dlBuffer > 3
      ? "text-profit"
      : dlBuffer > 1
        ? "text-yellow-400"
        : "text-loss";
  const tlTone =
    tlBuffer > 5
      ? "text-profit"
      : tlBuffer > 2
        ? "text-yellow-400"
        : "text-loss";
  return (
    <section className="bg-surface rounded-xl p-5">
      <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide mb-3">
        Equity
      </h2>
      <div className="text-3xl font-bold">{fmtUsd(e.currentUsd)}</div>
      <div className={`text-sm font-mono ${totalTone}`}>
        {fmtPct(e.totalPnlPct)} total
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
        <Stat
          label="Day start"
          value={fmtUsd(e.dayStartUsd)}
          sub={`Daily P&L ${fmtPct(e.dailyPnlPct)}`}
          tone={dailyTone}
        />
        <Stat
          label="Challenge peak"
          value={fmtUsd(e.peakUsd)}
          sub={e.peakAt ? `at ${new Date(e.peakAt).toLocaleString()}` : "—"}
        />
        <Stat
          label="Daily-loss cap (-5%)"
          value={fmtPct(e.dlCapPct)}
          sub={`${fmtPct(dlBuffer)} buffer`}
          tone={dlTone}
        />
        <Stat
          label="Total-loss cap (-10%)"
          value={fmtPct(e.tlCapPct)}
          sub={`${fmtPct(tlBuffer)} buffer`}
          tone={tlTone}
        />
      </div>
      <RuleBars rp={data.ruleProgress} />
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-xs text-txt/60 uppercase tracking-wide">{label}</div>
      <div className={`text-base font-mono ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-txt/50">{sub}</div>}
    </div>
  );
}

function RuleBars({ rp }: { rp: DriftData["ruleProgress"] }) {
  return (
    <div className="mt-4 space-y-2">
      <ProgressBar
        label="Profit target progress"
        pct={rp.profitTargetProgress}
        color="bg-profit"
      />
      <ProgressBar
        label="Daily-loss used"
        pct={rp.dailyLossUsed}
        color={
          rp.dailyLossUsed >= 0.85
            ? "bg-loss"
            : rp.dailyLossUsed >= 0.5
              ? "bg-yellow-500"
              : "bg-yellow-400/40"
        }
      />
      <ProgressBar
        label="Total-loss used"
        pct={rp.totalLossUsed}
        color={
          rp.totalLossUsed >= 0.85
            ? "bg-loss"
            : rp.totalLossUsed >= 0.5
              ? "bg-yellow-500"
              : "bg-yellow-400/40"
        }
      />
    </div>
  );
}

function ProgressBar({
  label,
  pct,
  color,
}: {
  label: string;
  pct: number;
  color: string;
}) {
  const clamped = Math.max(0, Math.min(1, pct));
  return (
    <div>
      <div className="flex justify-between text-xs text-txt/60 mb-1">
        <span>{label}</span>
        <span className="font-mono">{(clamped * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-surface/50 rounded overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-500`}
          style={{ width: `${clamped * 100}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active positions table
// ---------------------------------------------------------------------------

function PositionsTable({ data }: { data: DriftData }) {
  const positions = data.positions;
  return (
    <section className="bg-surface rounded-xl p-5">
      <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide mb-3">
        Active positions ({positions.length})
        {data.pendingCount > 0 && (
          <span className="ml-2 text-xs text-yellow-400">
            +{data.pendingCount} pending
          </span>
        )}
      </h2>
      {positions.length === 0 ? (
        <div className="text-txt/60 text-sm py-8 text-center">
          No open positions
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-left text-txt/60 uppercase text-[10px] tracking-wider">
              <tr>
                <th className="py-2 px-2">Asset</th>
                <th className="py-2 px-2">Dir</th>
                <th className="py-2 px-2 text-right">Size</th>
                <th className="py-2 px-2 text-right">Entry</th>
                <th className="py-2 px-2 text-right">SL</th>
                <th className="py-2 px-2 text-right">TP</th>
                <th className="py-2 px-2 text-right">PnL est</th>
                <th className="py-2 px-2 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                // Estimated PnL based on SL/entry distance — we don't have
                // live mid-price here, so approximate with entry (PnL=0) and
                // let the user know it's an estimate.
                const pnlPct = 0;
                const dirColor =
                  p.direction === "long" ? "text-profit" : "text-loss";
                return (
                  <tr
                    key={p.ticket}
                    className="border-t border-surface/30 font-mono"
                  >
                    <td className="py-2 px-2 font-bold">{p.signalAsset}</td>
                    <td className={`py-2 px-2 ${dirColor}`}>
                      {p.direction.toUpperCase()}
                    </td>
                    <td className="py-2 px-2 text-right">{p.lot}</td>
                    <td className="py-2 px-2 text-right">
                      ${p.entry_price.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-loss/80">
                      ${p.stop_price.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-profit/80">
                      ${p.tp_price.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-txt/70">
                      {fmtPct(pnlPct)}
                      <span className="text-[9px] text-txt/40 ml-1">est</span>
                    </td>
                    <td className="py-2 px-2 text-right text-txt/70">
                      {fmtAge(p.ageMin * 60)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Health checks (dots + age)
// ---------------------------------------------------------------------------

function HealthCard({ data }: { data: DriftData }) {
  const h = data.health;
  return (
    <section className="bg-surface rounded-xl p-5">
      <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide mb-3">
        Health checks
      </h2>
      <div className="space-y-2">
        <HealthRow
          ok={h.botHeartbeatOk}
          label="Bot heartbeat"
          detail={`last log ${fmtAge(h.botHeartbeatAgeSec)} ago (≤ 5min)`}
        />
        <HealthRow
          ok={h.mt5Connected}
          label="MT5 connection"
          detail={
            h.mt5Connected
              ? "no recent disconnect events"
              : "broker_unreachable / mt5_init_failed seen"
          }
        />
        <HealthRow
          ok={h.telegramOk}
          label="Telegram alerts"
          detail={
            h.telegramOk ? "no send-failed events" : "telegram_send_failed seen"
          }
        />
        <HealthRow
          ok={h.signalFeedFresh}
          label="Signal feed"
          detail={
            h.signalFeedAgeMin === null
              ? "no signal events yet"
              : `last eval ${Math.round(h.signalFeedAgeMin)}m ago (≤ 6h)`
          }
        />
      </div>
    </section>
  );
}

function HealthRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-label={ok ? "ok" : "fail"}
        className={`inline-block w-2.5 h-2.5 rounded-full ${
          ok
            ? "bg-profit shadow-[0_0_8px_#10b981]"
            : "bg-loss shadow-[0_0_8px_#ef4444]"
        }`}
      />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-txt/50">{detail}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent events log (collapsible)
// ---------------------------------------------------------------------------

function EventsLog({
  data,
  open,
  onToggle,
}: {
  data: DriftData;
  open: boolean;
  onToggle: (v: boolean) => void;
}) {
  const events = data.recentEvents;
  return (
    <section className="bg-surface rounded-xl">
      <button
        onClick={() => onToggle(!open)}
        className="w-full flex items-center justify-between p-5 text-left"
        aria-expanded={open}
      >
        <h2 className="text-sm font-semibold text-txt/70 uppercase tracking-wide">
          Recent events ({events.length})
        </h2>
        <span className="text-txt/60 text-sm">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <div className="px-5 pb-5">
          {events.length === 0 ? (
            <div className="text-txt/60 text-sm py-4 text-center">
              No recent events
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto text-xs font-mono space-y-1">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="border-t border-surface/30 pt-1.5 pb-1 grid grid-cols-[auto_auto_1fr] gap-2"
                >
                  <span className="text-txt/50 whitespace-nowrap">
                    {fmtTimeAgo(e.ts)}
                  </span>
                  <span className="text-yellow-300/90 whitespace-nowrap">
                    {e.event}
                  </span>
                  <span className="text-txt/60 truncate">
                    {summarizeEvent(e)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function summarizeEvent(e: ExecutorEvent): string {
  const skip: Record<string, true> = { ts: true, event: true };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (skip[k]) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    parts.push(`${k}=${String(v)}`);
    if (parts.join(" ").length > 120) break;
  }
  return parts.join(" ");
}
