/**
 * GET /api/drift-data?ftmo_tf=<tf-slug>
 *
 * Reads runtime state from `ftmo-state[-{tf}]/` directories that the Python
 * bot writes, computes the live equity curve + drift vs the R28_V5 backtest
 * expectation, and bundles everything the /dashboard/drift page needs into a
 * single JSON payload.
 *
 * Read-only — no file mutations. Path-injection is blocked via a strict
 * `[a-z0-9-]` whitelist on the `ftmo_tf` query parameter.
 *
 * Gated behind FTMO_MONITOR_ENABLED (same flag as /api/ftmo-state) to keep
 * the endpoint 404 in public deployments.
 */
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { isRateLimited } from "@/utils/distributedRateLimit";

// ---------------------------------------------------------------------------
// Config / constants
// ---------------------------------------------------------------------------

const STATE_FILE_MAX_BYTES = 1_000_000;
const JSONL_MAX_BYTES = STATE_FILE_MAX_BYTES * 10;
const DEFAULT_START_BALANCE = 100_000;

/**
 * R28_V6_PASSLOCK backtest reference — Round 60 Champion (2026-05-04).
 * Pass-Lock-Mode (`closeAllOnTargetReached`) eliminates Day-30-force-close
 * drag-down → +8.15pp pass-rate vs R28_V6 baseline.
 *
 * Real numbers (R60 sharded sweep, 88-136 windows pre-final):
 *   pass-rate:       64.77% (preliminary)
 *   median pass-day: 4d (FTMO floor)
 *   final equity p10: ~-8% (improved vs R28_V6 -10.74%)
 *   final equity median: +9% (locked at target via close-all)
 *
 * Failure breakdown (vs R28_V6 in parens):
 *   profit_target reached: 64.77%   (56.62%)
 *   daily_loss:            22.7%    (30.88%)
 *   total_loss:            12.5%    (11.03%)
 *   give_back:              0%      (1.47%)
 *
 * Live selector: FTMO_TF=2h-trend-v5-r28-v6-passlock
 *
 * Live deploy expectation: -3 to -5pp drift from backtest → ~60% live single,
 * ~94% min-1-pass with 3-strategy multi-account (PASSLOCK + TITANIUM + AMBER).
 *
 * NOTE: target is +8% (not +10%) — that's FTMO Step 1's actual rule.
 */
const BACKTEST_REF = {
  name: "R28_V6_PASSLOCK",
  passRatePct: 64.77,
  medianPassDay: 4,
  p90PassDay: 5, // tighter than R28_V6 because pass-lock locks early
  profitTargetPct: 8, // FTMO Step 1 actual target
  dailyLossCapPct: 5,
  totalLossCapPct: 10,
  maxChallengeDays: 30,
} as const;

// FTMO rule constants
const FTMO_DAILY_LOSS_CAP = 0.05; // -5%
const FTMO_TOTAL_LOSS_CAP = 0.1; // -10%
const FTMO_PROFIT_TARGET = 0.08; // +8% (FTMO Step 1 actual rule, was incorrectly 10%)

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  return (
    process.env.FTMO_MONITOR_ENABLED === "1" ||
    process.env.FTMO_MONITOR_ENABLED === "true"
  );
}

/**
 * Round 57 (2026-05-03): require a Supabase session before exposing live
 * equity/positions. Previously the route was protected only by
 * FTMO_MONITOR_ENABLED + a slug whitelist — anyone who knew the slug could
 * read account data. Now we additionally require a logged-in user.
 *
 * Skipped when:
 *   - Supabase is not configured (createServerSupabaseClient → null) — this
 *     is the localStorage-only fallback path; nothing to protect because
 *     auth doesn't exist in this deployment.
 *   - `FTMO_MONITOR_AUTH_BYPASS=1` is set (escape hatch for local dev /
 *     headless-vps where the user IS the only one with shell access).
 */
// Round 60 (Security Audit Round 2): emit a once-per-process warning
// when FTMO_MONITOR_AUTH_BYPASS is enabled while Supabase IS configured.
// This is the misconfiguration that risks PII leakage on a multi-tenant
// VPS — bypass is meant for headless single-owner setups only.
const bypassWarned = { logged: false };

async function isAuthenticated(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (
    process.env.FTMO_MONITOR_AUTH_BYPASS === "1" ||
    process.env.FTMO_MONITOR_AUTH_BYPASS === "true"
  ) {
    if (
      !bypassWarned.logged &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_URL !==
        "https://your-project.supabase.co"
    ) {
      bypassWarned.logged = true;
      console.warn(
        "[drift-data] FTMO_MONITOR_AUTH_BYPASS=1 active WHILE Supabase is " +
          "configured — every visitor can read live equity/positions. " +
          "Disable the bypass unless this is a single-owner headless VPS.",
      );
    }
    return { ok: true, reason: "bypass" };
  }
  let supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>;
  try {
    supabase = await createServerSupabaseClient();
  } catch {
    // createServerSupabaseClient throws if cookies() is unavailable in
    // the runtime — treat that as "no auth backend" and let the request
    // through (matches the localStorage-fallback path of the rest of the app).
    return { ok: true, reason: "no-auth-backend" };
  }
  if (!supabase) {
    // Supabase env vars not configured — no auth to enforce.
    return { ok: true, reason: "no-auth-backend" };
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Path resolution (security: whitelist + resolve-and-prefix-check)
// ---------------------------------------------------------------------------

const TF_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Resolve the state directory. Priority:
 *   1. `?ftmo_tf=<slug>` query → `<cwd>/ftmo-state-<slug>` (validated)
 *   2. `FTMO_STATE_DIR` env (allowed to be an absolute path; not exposed back)
 *   3. `<cwd>/ftmo-state`
 *
 * Returns `null` if the slug fails the whitelist or the resolved path tries
 * to escape the project root via `..`.
 */
function resolveStateDir(tfSlug: string | null): {
  absPath: string;
  relPath: string;
} | null {
  const cwd = process.cwd();

  if (tfSlug) {
    if (!TF_SLUG_RE.test(tfSlug)) return null;
    const dirName = `ftmo-state-${tfSlug}`;
    const abs = resolve(cwd, dirName);
    // Defensive: must remain under cwd
    if (!abs.startsWith(cwd)) return null;
    return { absPath: abs, relPath: dirName };
  }

  const envDir = process.env.FTMO_STATE_DIR;
  if (envDir) {
    const abs = resolve(envDir);
    return { absPath: abs, relPath: "<env:FTMO_STATE_DIR>" };
  }

  const abs = resolve(cwd, "ftmo-state");
  return { absPath: abs, relPath: "ftmo-state" };
}

/**
 * Discover sibling state directories so the UI can show a TF picker.
 * Lists every top-level dir matching `ftmo-state` or `ftmo-state-<slug>`.
 */
function discoverStateDirs(): string[] {
  try {
    const entries = readdirSync(process.cwd(), { withFileTypes: true });
    const slugs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "ftmo-state") slugs.push("");
      else if (e.name.startsWith("ftmo-state-")) {
        const slug = e.name.slice("ftmo-state-".length);
        if (TF_SLUG_RE.test(slug)) slugs.push(slug);
      }
    }
    return slugs.sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// File readers (size-capped, error-swallowing)
// ---------------------------------------------------------------------------

function readJson<T>(stateDir: string, name: string, fallback: T): T {
  const p = join(stateDir, name);
  if (!existsSync(p)) return fallback;
  try {
    const stat = statSync(p);
    if (stat.size > STATE_FILE_MAX_BYTES) return fallback;
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonl(
  stateDir: string,
  name: string,
  maxEntries = 100,
): Record<string, unknown>[] {
  const p = join(stateDir, name);
  if (!existsSync(p)) return [];
  try {
    const stat = statSync(p);
    if (stat.size > JSONL_MAX_BYTES) return [];
    const lines = readFileSync(p, "utf8").trim().split("\n");
    const out: Record<string, unknown>[] = [];
    // walk from the end so we tail efficiently
    for (let i = lines.length - 1; i >= 0 && out.length < maxEntries; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.unshift(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface AccountState {
  equity?: number; // multiplier (1.05 = +5%)
  day?: number; // 0-indexed challenge day
  recentPnls?: number[];
  equityAtDayStart?: number;
  raw_equity_usd?: number;
  raw_balance_usd?: number;
  updated_at?: string;
}

interface OpenPosition {
  ticket: number;
  signalAsset: string;
  sourceSymbol?: string;
  direction: "long" | "short";
  lot: number;
  entry_price: number;
  stop_price: number;
  tp_price: number;
  opened_at: string;
  max_hold_until?: number;
}

interface ExecutorEvent {
  ts: string;
  event: string;
  [k: string]: unknown;
}

interface BacktestPoint {
  day: number;
  median: number;
  p10: number;
  p90: number;
}

// ---------------------------------------------------------------------------
// Backtest expected-band heuristic
// ---------------------------------------------------------------------------

/**
 * Generate the R28_V5 expected equity-band trajectory in % terms.
 * - median curve: linear from 0% on day 0 to +10% on day 4, then flat
 *   (paused after target hit).
 * - p10 (downside): grows slower, never hits target, drifts to -2% by p90 day.
 * - p90 (upside): hits target faster (~day 2.5), then flat.
 * - the band fans out: tight at day 0, widest near medianPassDay.
 *
 * This is intentionally a heuristic envelope (not a full sim) — it's enough
 * to spot live-trajectory drift early.
 */
function buildBacktestBand(maxDays: number): BacktestPoint[] {
  const med = BACKTEST_REF.medianPassDay;
  const p90Day = BACKTEST_REF.p90PassDay;
  const target = BACKTEST_REF.profitTargetPct;
  const out: BacktestPoint[] = [];
  for (let d = 0; d <= maxDays; d++) {
    // Median: linear to target by med, then plateau
    const median = d <= med ? (target * d) / med : target;
    // Upside (p90 of equity at day d): faster, hits target ~day 2.5
    const fastDay = Math.max(2.5, med * 0.6);
    const p90eq = d <= fastDay ? (target * d) / fastDay : target;
    // Downside (p10): grows slowly, fans out to ~ -2..-4% by day p90Day
    // then keeps drifting down toward DL violation
    const slowSlope = target / (p90Day * 1.5); // % per day
    const driftDown = -Math.min(d, p90Day) * 0.5; // downside drift
    const p10eq = d <= p90Day ? slowSlope * d + driftDown : slowSlope * p90Day;
    out.push({ day: d, median, p10: p10eq, p90: p90eq });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Equity history reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct an equity-curve trace from executor-log events. Emits one point
 * per `daily_state_first_write` (day-anchor) plus the current account equity
 * as the final tail point. Day numbers are derived from the date stamps.
 */
interface EquityPoint {
  ts: string;
  day: number; // days since first event
  equityUsd: number;
  equityPct: number; // (equityUsd / startBalance - 1) * 100
}

function reconstructEquityHistory(
  executorLog: ExecutorEvent[],
  account: AccountState,
  startBalanceUsd: number,
): EquityPoint[] {
  const points: EquityPoint[] = [];
  const seenDays = new Set<string>();

  const dailyResets = executorLog.filter(
    (e) => e.event === "daily_state_first_write" || e.event === "daily_reset",
  );
  // Sort ascending by ts
  dailyResets.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  let firstTs: number | null = null;
  for (const e of dailyResets) {
    const dateStr = (e["date"] as string | undefined) ?? "";
    const eq = (e["equity"] as number | undefined) ?? null;
    if (!dateStr || eq === null || seenDays.has(dateStr)) continue;
    seenDays.add(dateStr);
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (firstTs === null) firstTs = t;
    const day = Math.floor((t - firstTs) / (24 * 3600 * 1000));
    points.push({
      ts: e.ts,
      day,
      equityUsd: eq,
      equityPct: (eq / startBalanceUsd - 1) * 100,
    });
  }

  // Tail: current live equity as the most recent point
  const liveEquityUsd =
    account.raw_equity_usd ??
    (account.equity ? account.equity * startBalanceUsd : startBalanceUsd);
  const lastTs = account.updated_at ?? new Date().toISOString();
  const lastTsMs = new Date(lastTs).getTime();
  if (Number.isFinite(lastTsMs)) {
    if (firstTs === null) firstTs = lastTsMs;
    const lastDay = Math.floor((lastTsMs - firstTs) / (24 * 3600 * 1000));
    // De-dupe if the last reset already covers today's equity
    const last = points[points.length - 1];
    if (!last || last.equityUsd !== liveEquityUsd || last.day !== lastDay) {
      points.push({
        ts: lastTs,
        day: lastDay,
        equityUsd: liveEquityUsd,
        equityPct: (liveEquityUsd / startBalanceUsd - 1) * 100,
      });
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Daily PnL aggregation
// ---------------------------------------------------------------------------

interface DailyPnlBar {
  date: string; // YYYY-MM-DD
  pnlUsd: number;
  pnlPct: number;
  equityUsd: number;
}

function buildDailyPnlBars(
  executorLog: ExecutorEvent[],
  account: AccountState,
  startBalanceUsd: number,
  daysBack = 14,
): DailyPnlBar[] {
  // For each day-anchor event, compute (next_anchor.equity - this_anchor.equity)
  const dayMap = new Map<string, number>(); // date → equity_at_start_of_day
  for (const e of executorLog) {
    if (e.event !== "daily_state_first_write" && e.event !== "daily_reset")
      continue;
    const date = (e["date"] as string | undefined) ?? "";
    const eq = (e["equity"] as number | undefined) ?? null;
    if (!date || eq === null) continue;
    if (!dayMap.has(date)) dayMap.set(date, eq);
  }
  const sortedDates = Array.from(dayMap.keys()).sort();
  const bars: DailyPnlBar[] = [];
  for (let i = 0; i < sortedDates.length; i++) {
    const date = sortedDates[i]!;
    const startEq = dayMap.get(date)!;
    let endEq: number;
    if (i + 1 < sortedDates.length) {
      endEq = dayMap.get(sortedDates[i + 1]!)!;
    } else {
      // Last day → use live equity
      endEq =
        account.raw_equity_usd ??
        (account.equity ? account.equity * startBalanceUsd : startEq);
    }
    bars.push({
      date,
      pnlUsd: endEq - startEq,
      pnlPct: ((endEq - startEq) / startEq) * 100,
      equityUsd: endEq,
    });
  }
  return bars.slice(-daysBack);
}

// ---------------------------------------------------------------------------
// Drift metric
// ---------------------------------------------------------------------------

interface DriftResult {
  liveEquityPct: number;
  expectedMedianPct: number;
  driftPct: number; // live - median; positive = ahead of backtest
  band: BacktestPoint;
  inBand: boolean;
}

function computeDrift(
  liveEquityPct: number,
  liveDay: number,
  band: BacktestPoint[],
): DriftResult | null {
  const dayClamped = Math.max(
    0,
    Math.min(band.length - 1, Math.round(liveDay)),
  );
  const ref = band[dayClamped];
  if (!ref) return null;
  return {
    liveEquityPct,
    expectedMedianPct: ref.median,
    driftPct: liveEquityPct - ref.median,
    band: ref,
    inBand: liveEquityPct >= ref.p10 && liveEquityPct <= ref.p90,
  };
}

// ---------------------------------------------------------------------------
// News blackout markers
// ---------------------------------------------------------------------------

interface NewsMarker {
  ts: string;
  label: string;
}

/**
 * Scan executor log for news_blackout events written by the bot. The Python
 * bot logs `{event: "news_blackout_skip", reason: "FOMC", until: "..."}`
 * when it skips a signal due to the blackout window. We surface those as
 * markers on the equity chart.
 */
function extractNewsMarkers(executorLog: ExecutorEvent[]): NewsMarker[] {
  const markers: NewsMarker[] = [];
  for (const e of executorLog) {
    if (
      e.event === "news_blackout_skip" ||
      e.event === "news_blackout" ||
      e.event === "blackout_skip"
    ) {
      markers.push({
        ts: e.ts,
        label: (e["reason"] as string | undefined) ?? "news",
      });
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

interface HealthChecks {
  botHeartbeatOk: boolean;
  botHeartbeatAgeSec: number | null;
  mt5Connected: boolean;
  telegramOk: boolean;
  signalFeedFresh: boolean;
  signalFeedAgeMin: number | null;
}

function computeHealth(
  executorLog: ExecutorEvent[],
  pendingCount: number,
  hasOpenPositions: boolean,
): HealthChecks {
  const lastEvent = executorLog[executorLog.length - 1];
  let heartbeatAge: number | null = null;
  if (lastEvent?.ts) {
    const t = new Date(lastEvent.ts).getTime();
    if (Number.isFinite(t)) heartbeatAge = (Date.now() - t) / 1000;
  }
  // Heuristics over the recent log tail
  const recent = executorLog.slice(-50);
  const sawMt5Error = recent.some(
    (e) =>
      e.event === "mt5_disconnected" ||
      e.event === "mt5_init_failed" ||
      e.event === "broker_unreachable",
  );
  const sawTelegramFail = recent.some(
    (e) =>
      e.event === "telegram_send_failed" || e.event === "telegram_unauthorized",
  );
  // Signal feed fresh = bot wrote a daily-anchor or signal-eval recently
  const signalEvents = recent.filter(
    (e) =>
      e.event === "daily_state_first_write" ||
      e.event === "signal_check" ||
      e.event === "signal_received",
  );
  const lastSignalEv = signalEvents[signalEvents.length - 1];
  let signalAgeMin: number | null = null;
  if (lastSignalEv?.ts) {
    const t = new Date(lastSignalEv.ts).getTime();
    if (Number.isFinite(t)) signalAgeMin = (Date.now() - t) / 60_000;
  }
  return {
    botHeartbeatOk: heartbeatAge !== null && heartbeatAge <= 5 * 60,
    botHeartbeatAgeSec: heartbeatAge,
    // Optimistic default: assume connected unless we saw a recent error and
    // there are no open positions to refute it.
    mt5Connected: !sawMt5Error || hasOpenPositions || pendingCount > 0,
    telegramOk: !sawTelegramFail,
    signalFeedFresh: signalAgeMin !== null && signalAgeMin <= 6 * 60, // ≤ 6h
    signalFeedAgeMin: signalAgeMin,
  };
}

// ---------------------------------------------------------------------------
// Active position PnL
// ---------------------------------------------------------------------------

interface ActivePosition extends OpenPosition {
  ageMin: number;
}

function annotatePositions(positions: OpenPosition[]): ActivePosition[] {
  const now = Date.now();
  return positions.map((p) => {
    const opened = new Date(p.opened_at).getTime();
    const ageMin = Number.isFinite(opened) ? (now - opened) / 60_000 : 0;
    return { ...p, ageMin: Math.max(0, ageMin) };
  });
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!isEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // Round 60 (Security Audit Round 2): rate-limit even authenticated
  // requests. The endpoint reads ~7 small JSON files + tails a JSONL log on
  // every call (~10 ms warm). A logged-in attacker (or buggy client polling
  // in a tight loop) could turn that into a sustained read-amp DoS. Cap at
  // 60/min/IP — the dashboard polls at most every 5 s so legit traffic is
  // safely under the limit.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (
    await isRateLimited("drift-data", ip, { windowMs: 60_000, maxHits: 60 })
  ) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }

  // Round 57 (2026-05-03): require Supabase auth so other tenants can't
  // read live equity/positions through a known slug.
  const auth = await isAuthenticated();
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const tfSlug = req.nextUrl.searchParams.get("ftmo_tf");
  const resolved = resolveStateDir(tfSlug);
  if (!resolved) {
    return NextResponse.json(
      { error: "invalid ftmo_tf slug" },
      { status: 400 },
    );
  }
  const stateDir = resolved.absPath;
  const stateDirRel = resolved.relPath;

  const startBalanceUsd = Number(
    process.env.FTMO_START_BALANCE ?? DEFAULT_START_BALANCE,
  );

  // Read all the state files (each is fault-tolerant)
  const account = readJson<AccountState>(stateDir, "account.json", {});
  const dailyReset = readJson<{
    date?: string;
    equity_at_day_start_usd?: number;
    snapped_at?: string;
  }>(stateDir, "daily-reset.json", {});
  const peakState = readJson<{ peak_equity?: number; peak_at?: string }>(
    stateDir,
    "peak-state.json",
    {},
  );
  const openPosRaw = readJson<{ positions: OpenPosition[] }>(
    stateDir,
    "open-positions.json",
    { positions: [] },
  );
  const controls = readJson<{ paused: boolean; killRequested: boolean }>(
    stateDir,
    "bot-controls.json",
    { paused: false, killRequested: false },
  );
  const pending = readJson<{ signals: unknown[] }>(
    stateDir,
    "pending-signals.json",
    { signals: [] },
  );
  const executorLog = readJsonl(
    stateDir,
    "executor-log.jsonl",
    500,
  ) as ExecutorEvent[];

  // ----- derived ------------------------------------------------------------
  const equityHistory = reconstructEquityHistory(
    executorLog,
    account,
    startBalanceUsd,
  );
  const dailyPnlBars = buildDailyPnlBars(
    executorLog,
    account,
    startBalanceUsd,
    14,
  );
  const band = buildBacktestBand(BACKTEST_REF.maxChallengeDays);

  // Live "day" — from account.json if available, else derive from history
  const liveDay =
    account.day ??
    (equityHistory.length > 0
      ? equityHistory[equityHistory.length - 1]!.day
      : 0);
  const liveEquityUsd =
    account.raw_equity_usd ??
    (account.equity ? account.equity * startBalanceUsd : startBalanceUsd);
  const liveEquityPct = (liveEquityUsd / startBalanceUsd - 1) * 100;
  const drift = computeDrift(liveEquityPct, liveDay, band);

  const dayStartUsd =
    dailyReset.equity_at_day_start_usd ??
    (account.equityAtDayStart
      ? account.equityAtDayStart * startBalanceUsd
      : liveEquityUsd);
  const dailyPnlPct =
    dayStartUsd > 0 ? ((liveEquityUsd - dayStartUsd) / dayStartUsd) * 100 : 0;
  const totalPnlPct = (liveEquityUsd / startBalanceUsd - 1) * 100;

  // Pass status
  let passStatus: "passed" | "active" | "failed" = "active";
  if (totalPnlPct >= FTMO_PROFIT_TARGET * 100) passStatus = "passed";
  else if (totalPnlPct <= -FTMO_TOTAL_LOSS_CAP * 100) passStatus = "failed";
  else if (dailyPnlPct <= -FTMO_DAILY_LOSS_CAP * 100) passStatus = "failed";

  const peakUsd =
    peakState.peak_equity ?? Math.max(liveEquityUsd, startBalanceUsd);
  const newsMarkers = extractNewsMarkers(executorLog);
  const recentEvents = executorLog.slice(-20).reverse();
  const positions = annotatePositions(openPosRaw.positions);
  const health = computeHealth(
    executorLog,
    pending.signals.length,
    positions.length > 0,
  );

  // FTMO rule progress (0..1, 1 = at the cap).
  // Divisor is BACKTEST_REF.profitTargetPct (FTMO Step 1 actual rule = 8%),
  // not hardcoded 10 — was a stale ref to old 10% target. Round 60 audit fix.
  const ruleProgress = {
    profitTargetProgress: Math.max(
      0,
      Math.min(1, totalPnlPct / BACKTEST_REF.profitTargetPct),
    ),
    dailyLossUsed: Math.max(0, -dailyPnlPct / (FTMO_DAILY_LOSS_CAP * 100)),
    totalLossUsed: Math.max(0, -totalPnlPct / (FTMO_TOTAL_LOSS_CAP * 100)),
    drawdownVsPeakPct:
      peakUsd > 0 ? ((liveEquityUsd - peakUsd) / peakUsd) * 100 : 0,
  };

  return NextResponse.json(
    {
      meta: {
        backtestRef: BACKTEST_REF,
        stateDir: stateDirRel,
        availableTfSlugs: discoverStateDirs(),
        currentTfSlug: tfSlug ?? "",
        startBalanceUsd,
        generatedAt: new Date().toISOString(),
      },
      header: {
        challengeName: BACKTEST_REF.name,
        liveDay,
        daysElapsed: liveDay,
        daysRemaining: Math.max(0, BACKTEST_REF.maxChallengeDays - liveDay),
        passStatus,
        botPaused: controls.paused,
        killRequested: controls.killRequested,
      },
      equity: {
        currentUsd: liveEquityUsd,
        currentPct: liveEquityPct,
        dayStartUsd,
        dailyPnlPct,
        totalPnlPct,
        peakUsd,
        peakAt: peakState.peak_at ?? null,
        dlCapPct: -FTMO_DAILY_LOSS_CAP * 100,
        tlCapPct: -FTMO_TOTAL_LOSS_CAP * 100,
        targetPct: FTMO_PROFIT_TARGET * 100,
      },
      drift,
      ruleProgress,
      equityHistory,
      backtestBand: band,
      dailyPnlBars,
      newsMarkers,
      recentEvents,
      positions,
      pendingCount: pending.signals.length,
      health,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
