/**
 * GET /api/ftmo-state — returns all FTMO bot state JSON files bundled.
 *
 * Reads from FTMO_STATE_DIR (or ./ftmo-state by default). Used by the
 * /ftmo-monitor dashboard page.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as path from "node:path";
import { NextResponse } from "next/server";
import { requireFtmoMonitorAuth } from "@/lib/ftmoMonitorAuth";

function isEnabled() {
  return (
    process.env.FTMO_MONITOR_ENABLED === "1" ||
    process.env.FTMO_MONITOR_ENABLED === "true"
  );
}

function getStateDir() {
  return process.env.FTMO_STATE_DIR ?? join(process.cwd(), "ftmo-state");
}

// Phase 62 (R45-API-5): cap state-file reads at 1 MB so a corrupted /
// runaway-write state file can't blow the API response (and the Node
// memory of the function instance) up to multi-megabyte. State files
// in normal operation are ~1-50 KB.
const STATE_FILE_MAX_BYTES = 1_000_000;

function readJson<T = unknown>(name: string, fallback: T): T {
  const p = join(getStateDir(), name);
  if (!existsSync(p)) return fallback;
  try {
    const stat = statSync(p);
    if (stat.size > STATE_FILE_MAX_BYTES) {
      console.error(
        `[ftmo-state] ${name} too large (${stat.size}B > ${STATE_FILE_MAX_BYTES}B) — using fallback`,
      );
      return fallback;
    }
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonl(name: string, maxEntries = 100): unknown[] {
  const p = join(getStateDir(), name);
  if (!existsSync(p)) return [];
  try {
    const stat = statSync(p);
    if (stat.size > STATE_FILE_MAX_BYTES * 10) {
      // JSONL logs grow naturally — give them 10× headroom, but still cap.
      console.error(
        `[ftmo-state] ${name} too large (${stat.size}B) — returning empty`,
      );
      return [];
    }
    const lines = readFileSync(p, "utf8").trim().split("\n");
    return lines
      .slice(-maxEntries)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface EquitySample {
  ts: string;
  equity_usd: number;
  equity_pct: number;
}
interface ExecutorLogEntry {
  ts: string;
  event: string;
  [k: string]: unknown;
}

/**
 * Derive win/loss statistics from executor-log position_gone and closed events.
 * Very approximate — real stats come from MT5 history. We use whatever we have.
 */
function computeStats(executorLog: ExecutorLogEntry[]) {
  const wins: number[] = [];
  const losses: number[] = [];
  for (const e of executorLog) {
    if (e.event !== "closed" && e.event !== "position_gone") continue;
    // We don't always have pnl in the log entry; best-effort
    const pnl = typeof e["pnl"] === "number" ? (e["pnl"] as number) : null;
    if (pnl === null) continue;
    if (pnl > 0) wins.push(pnl);
    else if (pnl < 0) losses.push(pnl);
  }
  const total = wins.length + losses.length;
  if (total === 0) {
    return {
      total: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
    };
  }
  const sumWins = wins.reduce((s, v) => s + v, 0);
  const sumLosses = Math.abs(losses.reduce((s, v) => s + v, 0));
  return {
    total,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / total,
    avgWin: wins.length ? sumWins / wins.length : 0,
    avgLoss: losses.length ? -sumLosses / losses.length : 0,
    profitFactor: sumLosses > 0 ? sumWins / sumLosses : 0,
  };
}

function computeDrawdown(equityHistory: EquitySample[]) {
  if (!equityHistory.length) return { currentDd: 0, maxDd: 0, peak: 0 };
  // Phase 78: index access guarded by length check above; non-null safe.
  let peak = equityHistory[0]!.equity_usd;
  let maxDd = 0;
  for (const s of equityHistory) {
    if (s.equity_usd > peak) peak = s.equity_usd;
    const dd = (s.equity_usd - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  const last = equityHistory[equityHistory.length - 1]!;
  const currentDd = (last.equity_usd - peak) / peak;
  return { currentDd, maxDd, peak };
}

export async function GET() {
  // Gate: only expose when explicitly enabled (prevents leaks in production)
  if (!isEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }
  // R67 audit fix: require Supabase session (mirrors drift-data R57 hardening)
  const auth = await requireFtmoMonitorAuth();
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const account = readJson<{
    equity?: number;
    raw_equity_usd?: number;
    equityAtDayStart?: number;
    [k: string]: unknown;
  }>("account.json", {});
  const status = readJson("service-status.json", {});
  const pending = readJson("pending-signals.json", { signals: [] });
  const executed = readJson("executed-signals.json", { executions: [] });
  const openPos = readJson("open-positions.json", { positions: [] });
  const dailyReset = readJson<{
    equity_at_day_start_usd?: number;
    date?: string;
  }>("daily-reset.json", {});
  const controls = readJson("bot-controls.json", {
    paused: false,
    killRequested: false,
  });
  const lastCheck = readJson("last-check.json", {});
  const signalLog = readJsonl("signal-log.jsonl", 50);
  const executorLog = readJsonl(
    "executor-log.jsonl",
    100,
  ) as ExecutorLogEntry[];
  const equityHistory = readJsonl(
    "equity-history.jsonl",
    500,
  ) as EquitySample[];

  // Derived stats
  const stats = computeStats(executorLog);
  const drawdown = computeDrawdown(equityHistory);

  // FTMO rule progress (0..1, 1 = at the limit)
  const startBalance = Number(process.env.FTMO_START_BALANCE ?? "100000");
  const equityUsd = account.raw_equity_usd ?? startBalance;
  const dayStartUsd = dailyReset.equity_at_day_start_usd ?? equityUsd;
  const dailyLossPct = (equityUsd - dayStartUsd) / dayStartUsd; // negative on loss
  const totalLossPct = (equityUsd - startBalance) / startBalance;
  const totalGainPct = totalLossPct;
  const ruleProgress = {
    dailyLossUsed: Math.max(0, -dailyLossPct / 0.05), // 0 = no loss, 1 = at -5%
    totalLossUsed: Math.max(0, -totalLossPct / 0.1), // 0 = no loss, 1 = at -10%
    profitTargetProgress: Math.max(0, Math.min(1, totalGainPct / 0.1)), // 0 = start, 1 = hit +10%
    dailyLossPct,
    totalLossPct,
    totalGainPct,
  };

  return NextResponse.json(
    {
      account,
      status,
      pending,
      executed,
      openPos,
      dailyReset,
      controls,
      lastCheck,
      signalLog,
      executorLog,
      equityHistory: equityHistory.slice(-200), // cap for wire size
      stats,
      drawdown,
      ruleProgress,
      // Phase 33 (API Audit Bug 5): only relative path — leaking absolute
      // server filesystem paths is information-disclosure (server topology).
      stateDir: path.relative(process.cwd(), getStateDir()) || ".",
      generatedAt: new Date().toISOString(),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
