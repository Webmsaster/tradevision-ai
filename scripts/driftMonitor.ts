/**
 * driftMonitor.ts — Live-vs-Backtest drift report.
 *
 * Joins:
 *   - executor-log.jsonl `order_placed` events  (signal_entry, actual fill, spread)
 *   - executor-log.jsonl `closed` events         (planned_exit, actual close, slippage)
 *   - signal-alerts.log                          (full signal payload, optional cross-check)
 *
 * Outputs a Markdown report:
 *   - Per-asset: avg entry slippage (bps), avg exit slippage, avg spread,
 *     fill-success rate, avg P&L per trade vs backtest expected.
 *   - Aggregate: total live P&L, total expected (theoretical TP rate × tp_pct ×
 *     leverage × avg_risk minus stop rate × stop_pct × leverage × avg_risk),
 *     drift in pp.
 *   - Last-7-days bucket.
 *
 * Usage:
 *   npx tsx scripts/driftMonitor.ts \
 *     [--state-dir ftmo-state-2h-trend-v5-r28-v6-passlock-demo1] \
 *     [--days 7] \
 *     [--out drift-report.md]
 *
 * Exit code 0 always (for cron use). Errors print to stderr.
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import * as path from "node:path";

interface Args {
  stateDir: string;
  days: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    stateDir: process.env.FTMO_STATE_DIR ?? "ftmo-state-default",
    days: 7,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state-dir") a.stateDir = argv[++i]!;
    else if (arg === "--days") a.days = parseInt(argv[++i]!, 10);
    else if (arg === "--out") a.out = argv[++i]!;
  }
  return a;
}

interface OrderPlaced {
  ts: string;
  ticket: number;
  asset: string;
  direction: "long" | "short";
  signal_entry?: number;
  entry: number; // actual MT5 fill
  signal_stop?: number;
  signal_tp?: number;
  risk_frac?: number;
  stop_pct?: number;
  tp_pct?: number;
  slippage_bps?: number | null;
  spread_pts?: number | null;
  lot: number;
}

interface ClosedEvent {
  ts: string;
  ticket: number;
  close_price: number;
  entry_price?: number;
  planned_exit?: number;
  // R67 audit (Round 2): exit_reason now includes the explicit overrides
  // added in tools/ftmo_executor.py close_position. Without these in the
  // type union, the drift-monitor undercounted PASSLOCK/time/news closes
  // → tp/stop counts < total recent → winRate based on tpCount/recent
  // was systematically wrong, and expected_pnl_pct fell to 0 → drift
  // looked artificially green. Now treated as broker-driven realises.
  exit_reason?:
    | "tp"
    | "stop"
    | "manual"
    | "time_exit"
    | "hold_expired"
    | "news_blackout"
    | "kill_request"
    | string; // "emergency:..." prefix from _emergency_close_all_positions
  slippage_bps?: number | null;
  symbol?: string;
  volume?: number;
}

function readJsonlLines(p: string): unknown[] {
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf-8");
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip corrupt lines (rotation race etc)
    }
  }
  return out;
}

function readAllExecutorLogs(stateDir: string): unknown[] {
  // Read current jsonl + any rotated archives in the same dir.
  const entries: unknown[] = [];
  if (!existsSync(stateDir)) return entries;
  for (const f of readdirSync(stateDir)) {
    if (f === "executor-log.jsonl" || /^executor-log\.\d+\.jsonl$/.test(f)) {
      entries.push(...readJsonlLines(path.join(stateDir, f)));
    }
  }
  return entries;
}

interface JoinedTrade {
  ticket: number;
  asset: string;
  direction: "long" | "short";
  open_ts: string;
  close_ts: string;
  signal_entry: number | null;
  actual_entry: number;
  entry_slip_bps: number | null;
  signal_stop: number | null;
  signal_tp: number | null;
  risk_frac: number | null;
  stop_pct: number | null;
  tp_pct: number | null;
  // R67 audit (Round 3): widen JoinedTrade.exit_reason to match the source
  // type union (R67-r2 expanded ClosedEvent but JoinedTrade was missed).
  exit_reason:
    | "tp"
    | "stop"
    | "manual"
    | "time_exit"
    | "hold_expired"
    | "news_blackout"
    | "kill_request"
    | (string & {}) // accepts "emergency:..." prefix
    | null;
  planned_exit: number | null;
  actual_exit: number;
  exit_slip_bps: number | null;
  spread_pts: number | null;
  // Realised raw return (not lev-adjusted)
  raw_pnl_pct: number;
  // Backtest-expected raw (just the pct of the planned hit)
  expected_pnl_pct: number;
}

function joinTrades(events: unknown[]): JoinedTrade[] {
  const opens = new Map<number, OrderPlaced>();
  const closes: ClosedEvent[] = [];
  for (const e of events) {
    const ev = e as { event?: string };
    if (ev.event === "order_placed")
      opens.set((e as OrderPlaced).ticket, e as OrderPlaced);
    else if (ev.event === "closed") closes.push(e as ClosedEvent);
  }
  const out: JoinedTrade[] = [];
  for (const c of closes) {
    const o = opens.get(c.ticket);
    if (!o) continue; // close without open seen (older than log retention)
    const sign = o.direction === "long" ? 1 : -1;
    const raw_pnl_pct = (sign * (c.close_price - o.entry)) / o.entry;
    // 2026-05-23 Wave1 audit fix (HIGH): non-TP/Stop exits previously
    // hard-coded expected_pnl_pct=0, which artificially pulled the
    // drift-vs-expected average toward zero on PASSLOCK/time_exit/manual
    // exits (R60 reality). On a PASSLOCK-heavy day, drift looked green
    // (0% delta from 0% expected) even when real bot underperformed.
    // Use the ACTUAL realised price-delta as "expected" for these classes
    // — the exit reason was triggered by an in-engine rule, not a TP/SL
    // hit, so the realised PnL IS the engineered outcome.
    let expected_pnl_pct = 0;
    if (c.exit_reason === "tp" && o.tp_pct) {
      expected_pnl_pct = o.tp_pct;
    } else if (c.exit_reason === "stop" && o.stop_pct) {
      expected_pnl_pct = -o.stop_pct;
    } else if (
      c.exit_reason === "time" ||
      c.exit_reason === "manual" ||
      c.exit_reason === "passlock_target_hit" ||
      c.exit_reason === "force_close_max_days" ||
      c.exit_reason === "news_blackout" ||
      c.exit_reason === "emergency"
    ) {
      // Engine-driven exit — expected == realised by definition.
      expected_pnl_pct = raw_pnl_pct;
    }
    out.push({
      ticket: c.ticket,
      asset: o.asset,
      direction: o.direction,
      open_ts: o.ts,
      close_ts: c.ts,
      signal_entry: o.signal_entry ?? null,
      actual_entry: o.entry,
      entry_slip_bps: o.slippage_bps ?? null,
      signal_stop: o.signal_stop ?? null,
      signal_tp: o.signal_tp ?? null,
      risk_frac: o.risk_frac ?? null,
      stop_pct: o.stop_pct ?? null,
      tp_pct: o.tp_pct ?? null,
      exit_reason: c.exit_reason ?? null,
      planned_exit: c.planned_exit ?? null,
      actual_exit: c.close_price,
      exit_slip_bps: c.slippage_bps ?? null,
      spread_pts: o.spread_pts ?? null,
      raw_pnl_pct,
      expected_pnl_pct,
    });
  }
  return out;
}

function avg(arr: (number | null | undefined)[]): number | null {
  const v = arr.filter(
    (x): x is number => typeof x === "number" && Number.isFinite(x),
  );
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function fmt(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function buildReport(
  trades: JoinedTrade[],
  stateDir: string,
  days: number,
): string {
  const cutoff = Date.now() - days * 86400_000;
  const recent = trades.filter((t) => Date.parse(t.close_ts) >= cutoff);

  const lines: string[] = [];
  lines.push(`# Live-vs-Backtest Drift Report`);
  lines.push("");
  lines.push(`- **State dir:** \`${stateDir}\``);
  lines.push(
    `- **Window:** last ${days} days (${recent.length} closed trades)`,
  );
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push("");

  if (recent.length === 0) {
    lines.push(
      "_No closed trades in window. Either no executor-log.jsonl with `order_placed`/`closed` " +
        "events yet, or the bot didn't trade. Re-run after at least one trade has closed._",
    );
    return lines.join("\n");
  }

  // --- Aggregate metrics ---------------------------------------------
  const tpCount = recent.filter((t) => t.exit_reason === "tp").length;
  const stopCount = recent.filter((t) => t.exit_reason === "stop").length;
  const manualCount = recent.filter((t) => t.exit_reason === "manual").length;

  const winRate = recent.length > 0 ? tpCount / recent.length : 0;
  // R29-Frontend-Audit Bug 13: previously the effective return was
  // `raw_pnl_pct * risk_frac * 2`. `risk_frac` is the desired loss
  // fraction of equity if the stop trips, NOT a fixed 2x leverage
  // multiplier. The correct equity-return is
  //   raw_pnl_pct * (risk_frac / stop_pct)
  // because (1 / stop_pct) is the leverage chosen to hit the target
  // loss when the stop triggers. We fall back to the historical
  // 0.4 × 2 product (=0.8) when either field is missing so the report
  // doesn't break on legacy logs.
  const effExposure = (t: JoinedTrade): number => {
    const rf = t.risk_frac ?? 0.4;
    const sp = t.stop_pct;
    if (sp && Number.isFinite(sp) && sp > 0) return rf / sp;
    return rf * 2; // legacy fallback
  };
  const totalRealisedPct =
    recent.reduce((s, t) => s + t.raw_pnl_pct * effExposure(t), 0) /
    Math.max(1, recent.length);
  const totalExpectedPct =
    recent.reduce((s, t) => s + t.expected_pnl_pct * effExposure(t), 0) /
    Math.max(1, recent.length);
  const drift_pp = (totalRealisedPct - totalExpectedPct) * 100;

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(
    `| Closed trades | ${recent.length} (TP: ${tpCount}, Stop: ${stopCount}, Manual: ${manualCount}) |`,
  );
  lines.push(`| Win rate | **${(winRate * 100).toFixed(1)}%** |`);
  lines.push(
    `| Avg realised return / trade (eff) | ${fmt(totalRealisedPct * 100, 4)}% |`,
  );
  lines.push(
    `| Avg expected return / trade (eff) | ${fmt(totalExpectedPct * 100, 4)}% |`,
  );
  lines.push(
    `| **Drift** (realised − expected) | **${drift_pp >= 0 ? "+" : ""}${drift_pp.toFixed(2)}pp** |`,
  );
  lines.push(
    `| Avg entry slippage | ${fmt(avg(recent.map((t) => t.entry_slip_bps)))} bps |`,
  );
  lines.push(
    `| Avg exit slippage  | ${fmt(avg(recent.map((t) => t.exit_slip_bps)))} bps |`,
  );
  lines.push(
    `| Avg spread (pts)   | ${fmt(avg(recent.map((t) => t.spread_pts)))} |`,
  );
  lines.push("");

  // --- Per-asset breakdown -------------------------------------------
  const byAsset = new Map<string, JoinedTrade[]>();
  for (const t of recent) {
    if (!byAsset.has(t.asset)) byAsset.set(t.asset, []);
    byAsset.get(t.asset)!.push(t);
  }
  const sortedAssets = [...byAsset.keys()].sort();

  lines.push(`## Per-Asset`);
  lines.push("");
  lines.push(
    `| Asset | Trades | Win % | Avg entry slip (bps) | Avg exit slip (bps) | Avg spread | Realised | Expected | Drift (pp) |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const asset of sortedAssets) {
    const ts = byAsset.get(asset)!;
    const tpA = ts.filter((t) => t.exit_reason === "tp").length;
    const winA = ts.length ? (tpA / ts.length) * 100 : 0;
    // R29-Frontend-Audit Bug 13: see effExposure helper above.
    const realised = avg(ts.map((t) => t.raw_pnl_pct * effExposure(t)));
    const expected = avg(ts.map((t) => t.expected_pnl_pct * effExposure(t)));
    const driftA =
      realised !== null && expected !== null
        ? (realised - expected) * 100
        : null;
    lines.push(
      `| ${asset} | ${ts.length} | ${winA.toFixed(1)}% | ${fmt(avg(ts.map((t) => t.entry_slip_bps)))} | ${fmt(avg(ts.map((t) => t.exit_slip_bps)))} | ${fmt(avg(ts.map((t) => t.spread_pts)))} | ${fmt(realised !== null ? realised * 100 : null, 4)}% | ${fmt(expected !== null ? expected * 100 : null, 4)}% | ${driftA === null ? "—" : (driftA >= 0 ? "+" : "") + driftA.toFixed(2)} |`,
    );
  }
  lines.push("");

  // --- Slippage health alerts ----------------------------------------
  const allEntrySlip = recent
    .map((t) => t.entry_slip_bps)
    .filter((x): x is number => typeof x === "number");
  const allExitSlip = recent
    .map((t) => t.exit_slip_bps)
    .filter((x): x is number => typeof x === "number");
  const entryMedian = allEntrySlip.length ? median(allEntrySlip) : 0;
  const exitMedian = allExitSlip.length ? median(allExitSlip) : 0;

  lines.push(`## Slippage Health`);
  lines.push("");
  lines.push(`- Entry slip median: **${entryMedian.toFixed(1)} bps**`);
  lines.push(`- Exit slip median: **${exitMedian.toFixed(1)} bps**`);
  if (entryMedian > 5)
    lines.push(
      `- ⚠️ Entry slippage exceeds 5 bps median — broker conditions may have degraded.`,
    );
  if (exitMedian > 10)
    lines.push(
      `- ⚠️ Exit slippage exceeds 10 bps median — stop-out fills are running wide.`,
    );
  if (drift_pp < -1)
    lines.push(
      `- 🚨 Drift exceeds 1pp below expected — investigate signals/sizing/news-blackout.`,
    );
  if (drift_pp >= -1 && drift_pp <= 1)
    lines.push(
      `- ✅ Drift within ±1pp of expected — backtest assumptions hold.`,
    );
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.stateDir)) {
    console.error(`state dir not found: ${args.stateDir}`);
    console.error(`Set FTMO_STATE_DIR or pass --state-dir <path>`);
    return;
  }
  const events = readAllExecutorLogs(args.stateDir);
  if (events.length === 0) {
    console.error(`no executor-log entries in ${args.stateDir}`);
  }
  const trades = joinTrades(events);
  const report = buildReport(trades, args.stateDir, args.days);
  if (args.out) {
    writeFileSync(args.out, report);
    console.log(`wrote ${args.out} (${trades.length} joined trades)`);
  } else {
    console.log(report);
  }
}

main();
