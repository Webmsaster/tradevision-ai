/**
 * Signal Journal — persistent record of LIVE signals and their outcomes.
 *
 * Purpose: the backtested Sharpe is an estimate. The only way to know the
 * TRUE Sharpe of the system as deployed is to log every real-time signal
 * and track whether it won/lost. This module persists to localStorage so
 * the data survives page refreshes.
 *
 * Once ~50 live signals are accumulated, the user has a genuine out-of-
 * sample Sharpe that can be compared to the backtest estimate — the gap
 * between the two is the "reality discount."
 */

const STORAGE_KEY = "tradevision-signal-journal-v1";

export interface SignalEntry {
  id: string;
  symbol: string;
  strategy: string;
  direction: "long" | "short";
  entryTime: number; // ms UTC
  entryPrice: number;
  targetPrice: number | null;
  stopPrice: number | null;
  plannedExitTime: number; // ms UTC
  confidence: "high" | "medium" | "low";
  expectedEdgeBps: number;

  // Filled in when the signal exits
  exitTime?: number;
  exitPrice?: number;
  actualPnlPct?: number;
  exitReason?: "time" | "target" | "stop" | "abort" | "expired";

  // Optional user notes
  notes?: string;
}

export interface JournalStats {
  totalSignals: number;
  completed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  sharpe: number; // naive, per-trade stdev
  totalReturnPct: number;
  byStrategy: Record<
    string,
    {
      n: number;
      wins: number;
      meanPct: number;
      sharpe: number;
    }
  >;
}

export function loadJournal(): SignalEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SignalEntry[];
  } catch {
    return [];
  }
}

export function saveJournal(entries: SignalEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function recordSignal(
  entry: Omit<SignalEntry, "id"> & { id?: string },
): SignalEntry {
  const all = loadJournal();
  const id = entry.id ?? `${entry.strategy}-${entry.symbol}-${entry.entryTime}`;
  // Dedupe: if an entry with same id exists, merge updates in
  const existing = all.find((e) => e.id === id);
  if (existing) {
    Object.assign(existing, entry);
    saveJournal(all);
    return existing;
  }
  const full: SignalEntry = { ...entry, id };
  all.push(full);
  saveJournal(all);
  return full;
}

export function closeSignal(
  id: string,
  exitPrice: number,
  exitReason: SignalEntry["exitReason"] = "time",
): SignalEntry | null {
  const all = loadJournal();
  const entry = all.find((e) => e.id === id);
  if (!entry || entry.exitPrice !== undefined) return null;
  entry.exitTime = Date.now();
  entry.exitPrice = exitPrice;
  entry.exitReason = exitReason;
  entry.actualPnlPct =
    entry.direction === "long"
      ? (exitPrice - entry.entryPrice) / entry.entryPrice
      : (entry.entryPrice - exitPrice) / entry.entryPrice;
  saveJournal(all);
  return entry;
}

/**
 * Auto-close all open signals whose `plannedExitTime` has passed.
 *
 * For each expired open signal, records an exit at the latest price provided
 * in `latestPrices[symbol]` (must already be fetched by the caller — this
 * function is synchronous, no network). Signals without a live price are
 * skipped and logged.
 *
 * Returns the list of signals that were auto-closed in this call so the
 * caller can notify the UI.
 */
export function closeExpiredSignals(
  latestPrices: Record<string, number>,
  now: number = Date.now(),
): SignalEntry[] {
  const all = loadJournal();
  const closed: SignalEntry[] = [];
  let mutated = false;
  for (const entry of all) {
    const isOpen = entry.exitPrice === undefined;
    if (!isOpen) continue;
    if (entry.plannedExitTime > now) continue;
    const price = latestPrices[entry.symbol];
    if (!price || !isFinite(price) || price <= 0) continue;
    entry.exitTime = now;
    entry.exitPrice = price;
    entry.exitReason = "expired";
    entry.actualPnlPct =
      entry.direction === "long"
        ? (price - entry.entryPrice) / entry.entryPrice
        : (entry.entryPrice - price) / entry.entryPrice;
    closed.push(entry);
    mutated = true;
  }
  if (mutated) saveJournal(all);
  return closed;
}

export function computeJournalStats(entries: SignalEntry[]): JournalStats {
  const completed = entries.filter((e) => e.actualPnlPct !== undefined);
  const open = entries.filter((e) => e.actualPnlPct === undefined);
  const rets = completed.map((e) => e.actualPnlPct!);
  const wins = rets.filter((r) => r > 0).length;
  const losses = rets.filter((r) => r < 0).length;
  const winRate = rets.length > 0 ? wins / rets.length : 0;
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const variance =
    rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    Math.max(1, rets.length);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(250) : 0; // 250 trading days rough annualise
  const totalRet = rets.reduce((acc, r) => acc * (1 + r), 1) - 1;

  const byStrategy: JournalStats["byStrategy"] = {};
  for (const e of completed) {
    const s = byStrategy[e.strategy] ?? {
      n: 0,
      wins: 0,
      meanPct: 0,
      sharpe: 0,
    };
    s.n++;
    if ((e.actualPnlPct ?? 0) > 0) s.wins++;
    s.meanPct += e.actualPnlPct ?? 0;
    byStrategy[e.strategy] = s;
  }
  for (const key of Object.keys(byStrategy)) {
    const s = byStrategy[key];
    s.meanPct = s.n > 0 ? s.meanPct / s.n : 0;
    const stratRets = completed
      .filter((e) => e.strategy === key)
      .map((e) => e.actualPnlPct ?? 0);
    const m =
      stratRets.reduce((a, b) => a + b, 0) / Math.max(1, stratRets.length);
    const v =
      stratRets.reduce((a, b) => a + (b - m) * (b - m), 0) /
      Math.max(1, stratRets.length);
    const sd = Math.sqrt(v);
    s.sharpe = sd > 0 ? (m / sd) * Math.sqrt(250) : 0;
  }

  return {
    totalSignals: entries.length,
    completed: completed.length,
    open: open.length,
    wins,
    losses,
    winRate,
    avgReturnPct: mean,
    sharpe,
    totalReturnPct: totalRet,
    byStrategy,
  };
}
