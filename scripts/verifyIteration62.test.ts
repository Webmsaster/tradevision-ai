/**
 * Iter 62: Backtest-replay validating Kelly + Risk-Gate vs naive sizing.
 *
 * Question: does quarter-Kelly sizing + risk-cap actually outperform naive
 * 100%-all-in on HF daytrading backtest? Theory says: lower drawdown at
 * slight-to-zero return cost.
 *
 * Approach: run the iter57 HF daytrading config on 15m × 10 alts historical
 * data. For each signal that would have fired:
 *  - Simulate naive full-capital allocation
 *  - Simulate quarter-Kelly sizing
 *  - Simulate quarter-Kelly + risk-gate (daily-loss cap, max concurrent)
 *
 * Compare equity curves: total return, max drawdown, Sharpe, trades.
 *
 * The sizing methods use STRATEGY_EDGE_STATS["hf-daytrading"].
 */
import { describe, it } from "vitest";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  HF_DAYTRADING_CONFIG,
  HF_DAYTRADING_ASSETS,
} from "../src/utils/hfDaytrading";
import {
  STRATEGY_EDGE_STATS,
  recommendSize,
  type SizingMethod,
} from "../src/utils/positionSizing";
import { applyCosts } from "../src/utils/costModel";
import { MAKER_COSTS } from "../src/utils/intradayLab";
import {
  DEFAULT_RISK_LIMITS,
  type RiskLimits,
} from "../src/utils/riskManagement";
import type { Candle } from "../src/utils/indicators";

interface TradeEvent {
  t: number; // entry time
  closeT: number; // exit time
  symbol: string;
  direction: "long" | "short";
  entry: number;
  exit: number;
  netPnlPct: number;
  stop: number;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function stdReturns(c: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] <= 0) continue;
    r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
function smaOf(v: number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/** Extract each trade the hf-daytrading strategy would have opened on `candles`. */
function replayTrades(candles: Candle[], symbol: string): TradeEvent[] {
  const cfg = HF_DAYTRADING_CONFIG;
  const events: TradeEvent[] = [];
  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const w = candles.slice(i - cfg.lookback, i);
    const mv = median(w.map((c) => c.volume));
    if (mv <= 0) continue;
    const vZ = cur.volume / mv;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(w.map((c) => c.close));
    if (sd <= 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    const pZ = Math.abs(ret) / sd;
    if (pZ < cfg.priceZ) continue;
    const direction: "long" | "short" =
      cfg.mode === "fade"
        ? ret > 0
          ? "short"
          : "long"
        : ret > 0
          ? "long"
          : "short";
    // htf + micro filters
    const sma48 = smaOf(w.slice(-48).map((c) => c.close));
    const alignedLong = cur.close > sma48;
    if (direction === "long" && !alignedLong) continue;
    if (direction === "short" && alignedLong) continue;
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) continue;
    // fade mode: need exhaustion
    const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
    if (!sameDir) continue;

    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1 =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2 =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let stopL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= stopL : bar.high >= stopL;
      const t1 = direction === "long" ? bar.high >= tp1 : bar.low <= tp1;
      const t2 = direction === "long" ? bar.high >= tp2 : bar.low <= tp2;
      if (!tp1Hit) {
        if ((t1 && sH) || sH) {
          l2B = j;
          l2P = stopL;
          break;
        }
        if (t1) {
          tp1Hit = true;
          tp1Bar = j;
          if (cfg.useBreakeven) stopL = entry;
          if (t2) {
            l2B = j;
            l2P = tp2;
            break;
          }
          continue;
        }
      } else {
        const s2 = direction === "long" ? bar.low <= stopL : bar.high >= stopL;
        const t22 = direction === "long" ? bar.high >= tp2 : bar.low <= tp2;
        if ((t22 && s2) || s2) {
          l2B = j;
          l2P = stopL;
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2;
          break;
        }
      }
    }
    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction,
      holdingHours: (l2B - (i + 1)) * 0.25,
      config: MAKER_COSTS,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1,
        direction,
        holdingHours: (tp1Bar - (i + 1)) * 0.25,
        config: MAKER_COSTS,
      });
      leg1 = l1c.netPnlPct;
    } else {
      leg1 = leg2;
    }
    const total = 0.5 * leg1 + 0.5 * leg2;
    events.push({
      t: eb.openTime,
      closeT: candles[l2B].openTime,
      symbol,
      direction,
      entry,
      exit: l2P,
      netPnlPct: total,
      stop:
        direction === "long"
          ? entry * (1 - cfg.stopPct)
          : entry * (1 + cfg.stopPct),
    });
    i = l2B;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

interface SimResult {
  label: string;
  capital: number;
  tradesExecuted: number;
  tradesSkippedByRisk: number;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  winRate: number;
}

type Mode =
  | { kind: "naive"; allocPct: number } // fixed fraction per trade
  | { kind: "kelly"; method: SizingMethod; riskGate: boolean };

function simulate(events: TradeEvent[], mode: Mode, label: string): SimResult {
  const initial = 10_000;
  let capital = initial;
  const stats = STRATEGY_EDGE_STATS["hf-daytrading"];
  const limits: RiskLimits = DEFAULT_RISK_LIMITS;

  // Sort by entry time (cross-asset chronological)
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const equityCurve: number[] = [capital];
  const returns: number[] = [];
  let wins = 0;
  let executed = 0;
  let skipped = 0;

  // Track "open positions" by end-time so risk-gate can see concurrency
  interface OpenSlot {
    closeT: number;
    direction: "long" | "short";
    symbol: string;
    notional: number;
  }
  let openSlots: OpenSlot[] = [];

  // Track daily realised PnL (UTC days)
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const dayPnl: Record<string, number> = {};

  for (const ev of sorted) {
    // Close out any open slots whose closeT <= ev.t (they completed before this signal)
    openSlots = openSlots.filter((s) => s.closeT > ev.t);

    // Decide size + risk
    const today = dayKey(ev.t);
    const dailyRet = dayPnl[today] ?? 0;

    let notional = 0;
    if (mode.kind === "naive") {
      notional = capital * mode.allocPct;
    } else {
      const sizing = recommendSize({
        capital,
        entry: ev.entry,
        stop: ev.stop,
        stats,
        method: mode.method,
      });
      notional = sizing.notional;

      if (mode.riskGate) {
        // Apply risk caps
        const openCount = openSlots.length;
        const sameDir = openSlots.filter(
          (s) => s.direction === ev.direction,
        ).length;
        const dupSymbol = openSlots.some((s) => s.symbol === ev.symbol);
        const totalOpen = openSlots.reduce((s, v) => s + v.notional, 0);
        const reasons: string[] = [];
        if (dailyRet <= -limits.dailyLossPct) reasons.push("daily-cap");
        if (openCount >= limits.maxConcurrent) reasons.push("max-concurrent");
        if (sameDir >= limits.maxSameDirection) reasons.push("same-dir");
        if (dupSymbol) reasons.push("dup-symbol");
        if ((totalOpen + notional) / capital > limits.maxTotalExposureMult) {
          reasons.push("max-exposure");
        }
        if (reasons.length > 0) {
          skipped++;
          continue;
        }
      }
    }

    if (notional <= 0) {
      skipped++;
      continue;
    }

    // Realise PnL on this notional — dollar PnL = notional × netPnlPct
    const dollarPnl = notional * ev.netPnlPct;
    capital += dollarPnl;
    const portfolioRet = dollarPnl / (capital - dollarPnl); // % of pre-trade capital
    returns.push(portfolioRet);
    equityCurve.push(capital);
    if (ev.netPnlPct > 0) wins++;
    executed++;

    dayPnl[today] = (dayPnl[today] ?? 0) + ev.netPnlPct * (notional / capital);

    openSlots.push({
      closeT: ev.closeT,
      direction: ev.direction,
      symbol: ev.symbol,
      notional,
    });
  }

  // Stats
  const totalRet = capital / initial - 1;
  let peak = initial,
    maxDd = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  const m =
    returns.length > 0
      ? returns.reduce((s, v) => s + v, 0) / returns.length
      : 0;
  const v =
    returns.length > 0
      ? returns.reduce((s, x) => s + (x - m) * (x - m), 0) / returns.length
      : 0;
  const sd = Math.sqrt(v);
  // annualised: trades over the full period span
  const durDays =
    sorted.length > 0
      ? (sorted[sorted.length - 1].t - sorted[0].t) / 86400_000
      : 1;
  const perYear = durDays > 0 ? (executed / durDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  return {
    label,
    capital: initial,
    tradesExecuted: executed,
    tradesSkippedByRisk: skipped,
    finalEquity: capital,
    totalReturnPct: totalRet,
    maxDrawdownPct: maxDd,
    sharpe,
    winRate: executed > 0 ? wins / executed : 0,
  };
}

describe("iteration 62 — backtest replay: Kelly+risk vs naive sizing", () => {
  it(
    "compare 4 modes on HF-daytrading events",
    { timeout: 900_000 },
    async () => {
      console.log("\n=== ITER 62: Sizing Backtest-Replay ===");

      // Load data + extract events
      const allEvents: TradeEvent[] = [];
      for (const sym of HF_DAYTRADING_ASSETS) {
        try {
          const c = await loadBinanceHistory({
            symbol: sym,
            timeframe: "15m",
            targetCount: 10000,
          });
          const evs = replayTrades(c, sym);
          allEvents.push(...evs);
          console.log(`  ${sym}: ${evs.length} events`);
        } catch {
          console.log(`  ${sym}: fetch fail`);
        }
      }
      console.log(`\nTotal events: ${allEvents.length}`);

      const modes: Array<{ mode: Mode; label: string }> = [
        { mode: { kind: "naive", allocPct: 1.0 }, label: "naive all-in" },
        {
          mode: { kind: "naive", allocPct: 0.25 },
          label: "naive 25% per trade",
        },
        {
          mode: { kind: "kelly", method: "quarter-kelly", riskGate: false },
          label: "quarter-Kelly",
        },
        {
          mode: { kind: "kelly", method: "quarter-kelly", riskGate: true },
          label: "quarter-Kelly + risk-gate",
        },
        {
          mode: { kind: "kelly", method: "full-kelly", riskGate: true },
          label: "full-Kelly + risk-gate",
        },
      ];

      console.log(
        "\nlabel".padEnd(32) +
          "executed".padStart(10) +
          "skipped".padStart(10) +
          "WR%".padStart(7) +
          "finalEq".padStart(12) +
          "ret%".padStart(8) +
          "maxDD%".padStart(8) +
          "Sharpe".padStart(8),
      );
      for (const { mode, label } of modes) {
        const r = simulate(allEvents, mode, label);
        console.log(
          label.padEnd(32) +
            r.tradesExecuted.toString().padStart(10) +
            r.tradesSkippedByRisk.toString().padStart(10) +
            (r.winRate * 100).toFixed(1).padStart(7) +
            `$${r.finalEquity.toFixed(0)}`.padStart(12) +
            (r.totalReturnPct * 100).toFixed(1).padStart(8) +
            (r.maxDrawdownPct * 100).toFixed(1).padStart(8) +
            r.sharpe.toFixed(2).padStart(8),
        );
      }
    },
  );
});
