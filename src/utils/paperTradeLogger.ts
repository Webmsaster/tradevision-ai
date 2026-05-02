/**
 * Paper-Trade Logger — tracks every signal the analyzer fires and
 * simulates a real execution (maker-fill, scale-out, BE stop, time exit).
 *
 * Purpose: out-of-sample validation BEFORE risking real money. Run a tick
 * periodically (cron / cli), it
 *   1. records any newly-active signals as open paper-positions,
 *   2. advances open positions against current candles (check tp1/tp2/stop/time),
 *   3. closes positions that hit an exit and writes the realised PnL.
 *
 * Persisted state:
 *   ~/.tradevision-ai/paper-trades.json
 *     { openPositions: [...], closedTrades: [...], meta: {...} }
 *
 * Comparable to backtest so we can detect backtest→live degradation.
 */
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";
import type { Candle } from "@/utils/indicators";

export type PaperStrategy = "hf-daytrading" | "hi-wr-1h" | "vol-spike-1h";

export interface PaperPosition {
  id: string;
  strategy: PaperStrategy;
  symbol: string;
  direction: "long" | "short";
  entry: number;
  tp1?: number;
  tp2?: number;
  stop: number;
  entryTime: string; // ISO
  holdUntil: string; // ISO
  /** Whether tp1 has been hit and stop has moved to breakeven. */
  tp1Hit: boolean;
  tp1Time?: string;
  /** Position size in "legs" — default 2 (50% at tp1, 50% at tp2). Vol-spike
   *  edges don't scale out → 1 leg. */
  legs: 1 | 2;
}

export type ExitReason = "tp1" | "tp2" | "stop" | "breakeven" | "time";

export interface ClosedTrade {
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
  exitReason: ExitReason;
  /** For scale-out strategies: realised sum across legs. */
  legPnls?: number[];
  tp1HitAt?: string;
}

export interface PaperState {
  openPositions: PaperPosition[];
  closedTrades: ClosedTrade[];
  lastTickAt?: string;
}

export function emptyState(): PaperState {
  return { openPositions: [], closedTrades: [] };
}

function uuid(): string {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

/** Create a new paper position from an active signal snapshot. */
export function openPosition(args: {
  strategy: PaperStrategy;
  symbol: string;
  direction: "long" | "short";
  entry: number;
  tp1?: number;
  tp2?: number;
  stop: number;
  holdUntil: string;
  legs: 1 | 2;
  now?: string;
}): PaperPosition {
  return {
    id: uuid(),
    strategy: args.strategy,
    symbol: args.symbol,
    direction: args.direction,
    entry: args.entry,
    tp1: args.tp1,
    tp2: args.tp2,
    stop: args.stop,
    entryTime: args.now ?? new Date().toISOString(),
    holdUntil: args.holdUntil,
    tp1Hit: false,
    legs: args.legs,
  };
}

/**
 * Advance one open position against bars that post-date its entry. Mutates
 * the position in place (for tp1→BE), may close it and return a ClosedTrade.
 *
 * @param bars  chronologically-ordered candles STRICTLY AFTER position.entryTime
 * @param now   current wall-clock ISO — used only to enforce time-exit
 */
export function advancePosition(
  position: PaperPosition,
  bars: Candle[],
  now: string,
  costs: CostConfig = MAKER_COSTS,
): ClosedTrade | null {
  const holdDeadlineMs = new Date(position.holdUntil).getTime();
  const nowMs = new Date(now).getTime();

  for (const bar of bars) {
    const barTimeMs = bar.closeTime;
    if (barTimeMs <= new Date(position.entryTime).getTime()) continue;

    const stopHit =
      position.direction === "long"
        ? bar.low <= position.stop
        : bar.high >= position.stop;
    const tp2Hit =
      position.tp2 !== undefined &&
      (position.direction === "long"
        ? bar.high >= position.tp2
        : bar.low <= position.tp2);
    const tp1Hit =
      position.tp1 !== undefined &&
      !position.tp1Hit &&
      (position.direction === "long"
        ? bar.high >= position.tp1
        : bar.low <= position.tp1);

    // Resolve bar-internal order: stops are conservative (assume worst).
    if (!position.tp1Hit) {
      if (tp1Hit && stopHit) {
        return closeAtStop(position, bar, costs);
      }
      if (stopHit) {
        return closeAtStop(position, bar, costs);
      }
      if (tp1Hit) {
        // partial exit for 2-leg; full exit for 1-leg
        if (position.legs === 1 || position.tp2 === undefined) {
          return closeAt(position, bar, position.tp1!, "tp1", costs);
        }
        position.tp1Hit = true;
        position.tp1Time = new Date(bar.closeTime).toISOString();
        position.stop = position.entry; // BE
        if (tp2Hit) {
          return closeLeg2AtTp2(position, bar, costs);
        }
        continue;
      }
    } else {
      // already past tp1 → leg2 still open, stop is at entry (BE)
      if (tp2Hit && stopHit) {
        return closeLeg2AtBreakeven(position, bar, costs);
      }
      if (tp2Hit) {
        return closeLeg2AtTp2(position, bar, costs);
      }
      if (stopHit) {
        return closeLeg2AtBreakeven(position, bar, costs);
      }
    }
  }

  // Time stop?
  if (nowMs >= holdDeadlineMs && bars.length > 0) {
    const last = bars[bars.length - 1]!;
    return closeAt(position, last, last.close, "time", costs);
  }
  return null;
}

function closeAt(
  p: PaperPosition,
  bar: Candle,
  exitPx: number,
  reason: ExitReason,
  costs: CostConfig,
): ClosedTrade {
  const hours = (bar.closeTime - new Date(p.entryTime).getTime()) / 3_600_000;
  const c = applyCosts({
    entry: p.entry,
    exit: exitPx,
    direction: p.direction,
    holdingHours: hours,
    config: costs,
  });
  return {
    id: p.id,
    strategy: p.strategy,
    symbol: p.symbol,
    direction: p.direction,
    entry: p.entry,
    exit: exitPx,
    entryTime: p.entryTime,
    exitTime: new Date(bar.closeTime).toISOString(),
    grossPnlPct: c.grossPnlPct,
    netPnlPct: c.netPnlPct,
    exitReason: reason,
    tp1HitAt: p.tp1Time,
  };
}

function closeAtStop(
  p: PaperPosition,
  bar: Candle,
  costs: CostConfig,
): ClosedTrade {
  return closeAt(p, bar, p.stop, "stop", costs);
}

function closeLeg2AtTp2(
  p: PaperPosition,
  bar: Candle,
  costs: CostConfig,
): ClosedTrade {
  // leg1 was realized at tp1 earlier; leg2 at tp2 now. Composite PnL = avg.
  const leg1Net = legPnlAtExit(p, p.tp1!, p.tp1Time!, costs);
  const leg2Net = legPnlAtExit(
    p,
    p.tp2!,
    new Date(bar.closeTime).toISOString(),
    costs,
  );
  const total = 0.5 * leg1Net + 0.5 * leg2Net;
  return {
    id: p.id,
    strategy: p.strategy,
    symbol: p.symbol,
    direction: p.direction,
    entry: p.entry,
    exit: p.tp2!,
    entryTime: p.entryTime,
    exitTime: new Date(bar.closeTime).toISOString(),
    grossPnlPct:
      p.direction === "long"
        ? (p.tp2! - p.entry) / p.entry
        : (p.entry - p.tp2!) / p.entry,
    netPnlPct: total,
    exitReason: "tp2",
    legPnls: [leg1Net, leg2Net],
    tp1HitAt: p.tp1Time,
  };
}

function closeLeg2AtBreakeven(
  p: PaperPosition,
  bar: Candle,
  costs: CostConfig,
): ClosedTrade {
  const leg1Net = legPnlAtExit(p, p.tp1!, p.tp1Time!, costs);
  const leg2Net = legPnlAtExit(
    p,
    p.entry,
    new Date(bar.closeTime).toISOString(),
    costs,
  );
  const total = 0.5 * leg1Net + 0.5 * leg2Net;
  return {
    id: p.id,
    strategy: p.strategy,
    symbol: p.symbol,
    direction: p.direction,
    entry: p.entry,
    exit: p.entry,
    entryTime: p.entryTime,
    exitTime: new Date(bar.closeTime).toISOString(),
    grossPnlPct: 0,
    netPnlPct: total,
    exitReason: "breakeven",
    legPnls: [leg1Net, leg2Net],
    tp1HitAt: p.tp1Time,
  };
}

function legPnlAtExit(
  p: PaperPosition,
  exitPx: number,
  exitIso: string,
  costs: CostConfig,
): number {
  const hours =
    (new Date(exitIso).getTime() - new Date(p.entryTime).getTime()) / 3_600_000;
  const c = applyCosts({
    entry: p.entry,
    exit: exitPx,
    direction: p.direction,
    holdingHours: hours,
    config: costs,
  });
  return c.netPnlPct;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface PaperStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  avgReturnPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  byStrategy: Record<
    PaperStrategy,
    { trades: number; wins: number; wr: number; ret: number }
  >;
}

export function computeStats(closed: ClosedTrade[]): PaperStats {
  const wins = closed.filter((t) => t.netPnlPct > 0);
  const losses = closed.filter((t) => t.netPnlPct <= 0);
  const grossW = wins.reduce((s, v) => s + v.netPnlPct, 0);
  const grossL = Math.abs(losses.reduce((s, v) => s + v.netPnlPct, 0));
  const totalRet = closed.reduce((a, t) => a * (1 + t.netPnlPct), 1) - 1;
  const byStrategy: PaperStats["byStrategy"] = {
    "hf-daytrading": { trades: 0, wins: 0, wr: 0, ret: 0 },
    "hi-wr-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
    "vol-spike-1h": { trades: 0, wins: 0, wr: 0, ret: 0 },
  };
  for (const t of closed) {
    const s = byStrategy[t.strategy];
    s.trades++;
    if (t.netPnlPct > 0) s.wins++;
    s.ret += t.netPnlPct;
  }
  for (const k of Object.keys(byStrategy) as PaperStrategy[]) {
    byStrategy[k].wr =
      byStrategy[k].trades > 0 ? byStrategy[k].wins / byStrategy[k].trades : 0;
  }
  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalReturnPct: totalRet,
    avgReturnPct:
      closed.length > 0
        ? closed.reduce((s, t) => s + t.netPnlPct, 0) / closed.length
        : 0,
    avgWinPct: wins.length > 0 ? grossW / wins.length : 0,
    avgLossPct: losses.length > 0 ? -grossL / losses.length : 0,
    profitFactor: grossL > 0 ? grossW / grossL : wins.length > 0 ? 999 : 0,
    byStrategy,
  };
}
