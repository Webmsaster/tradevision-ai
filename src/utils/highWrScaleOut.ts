/**
 * High-Win-Rate Scaling-Out strategy (iter45-50 validated).
 *
 * After iter43-44 proved that tight-TP alone cannot hit 60% WR with positive
 * Sharpe under realistic costs, iter45-50 built a composite strategy:
 *
 *   Trigger:   volume-spike + price-z (same as LOCKED_EDGES[SUI momentum])
 *   Filters:   24h SMA trend alignment + micro-pullback + avoid funding hours
 *   Execution: scale-out in two legs — 50% at tp1, 50% at tp2, breakeven-stop
 *              after tp1 hits. Initial stop is 2.2× the base-edge stop.
 *
 * Iter50 bootstrap (19-window) on SUI 1h:
 *   tp1=0.5%/tp2=4.0%/stop×2.2 → medWR 77.4%, minWR 69.2%, medSh 0.75,
 *   pctProfitable 89%. Trade-off: highest WR of the analyzer, moderate Sharpe
 *   vs. the iter34 vol-spike edges (Sh 1.0-3.1, WR 40-55%).
 *
 * This module exports:
 *   1. `HIGH_WR_SUI_MOM_CONFIG` — the locked parameter set
 *   2. `runHighWrScaleOut()` — backtest driver (for dashboard stats)
 *   3. `evaluateHighWrSignal()` — live-signal evaluator (returns snapshot
 *      describing whether the trigger is active RIGHT NOW and, if so,
 *      the planned entry/tp1/tp2/stop)
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

export interface HighWrConfig {
  lookback: number;
  volMult: number;
  priceZ: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  mode: "fade" | "momentum";
  htfTrend: boolean;
  microPullback: boolean;
  useBreakeven: boolean;
  avoidHoursUtc: number[];
  costs?: CostConfig;
}

/**
 * Iter50 bootstrap-validated high-WR config for SUI-USDT momentum.
 * Trigger is identical to LOCKED_EDGES[SUI momentum]; scale-out + filters
 * are the WR-boosting additions.
 */
export const HIGH_WR_SUI_MOM_CONFIG: HighWrConfig = {
  lookback: 48,
  volMult: 3,
  priceZ: 2.0,
  tp1Pct: 0.005, // 0.5% — first partial exit
  tp2Pct: 0.04, // 4% — runner target
  stopPct: 0.012 * 2.2, // 2.64% — widened 2.2× vs locked edge
  holdBars: 6,
  mode: "momentum",
  htfTrend: true,
  microPullback: true,
  useBreakeven: true,
  avoidHoursUtc: [0, 8, 16, 5, 6], // funding hours (00/08/16) + low-liq (05/06)
  costs: MAKER_COSTS,
};

/** Iter50 lifetime stats, frozen at the time of locking. */
export const HIGH_WR_SUI_MOM_STATS = {
  iteration: 50,
  windowsTested: 19,
  medianWinRate: 0.774,
  minWinRate: 0.692,
  medianSharpe: 0.75,
  p25Sharpe: 0.21,
  minSharpe: -0.19,
  pctWindowsProfitable: 0.89,
  trigger: "SUI-USDT 1h volume-spike × price-z",
  filters: "24h-SMA trend + micro-pullback + avoid funding hours",
  execution: "scale-out 50% @ tp1 + 50% @ tp2, breakeven-stop after tp1",
} as const;

export interface HighWrTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  tp1Hit: boolean;
  leg1Pnl: number;
  leg2Pnl: number;
  totalPnl: number;
  exitReason: "stop" | "tp2" | "breakeven" | "time";
}

export interface HighWrReport {
  trades: HighWrTrade[];
  winRate: number;
  netReturnPct: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownPct: number;
  tp1HitRate: number;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stdReturns(closes: number[]): number {
  if (closes.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0) continue;
    r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (r.length === 0) return 0;
  const m = r.reduce((s, v) => s + v, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}

function smaOf(vals: number[], period: number): number {
  const slice = vals.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** Returns true if ALL filter conditions pass at bar index `i`. */
function passesFilters(
  candles: Candle[],
  i: number,
  cfg: HighWrConfig,
  direction: "long" | "short",
  ret: number,
): boolean {
  if (cfg.avoidHoursUtc.length) {
    const h = new Date(candles[i].openTime).getUTCHours();
    if (cfg.avoidHoursUtc.includes(h)) return false;
  }

  if (cfg.htfTrend) {
    const closes = candles
      .slice(Math.max(0, i - 23), i + 1)
      .map((c) => c.close);
    const smaVal = smaOf(closes, 24);
    const alignedLong = candles[i].close > smaVal;
    if (direction === "long" && !alignedLong) return false;
    if (direction === "short" && alignedLong) return false;
  }

  if (cfg.microPullback) {
    const penult = candles[i - 1];
    const before = candles[i - 2];
    if (!penult || !before) return false;
    if (cfg.mode === "momentum") {
      const hadPullback =
        direction === "long"
          ? penult.close < before.close
          : penult.close > before.close;
      if (!hadPullback) return false;
    } else {
      const sameDir =
        ret > 0 ? penult.close > before.close : penult.close < before.close;
      if (!sameDir) return false;
    }
  }

  return true;
}

export function runHighWrScaleOut(
  candles: Candle[],
  cfg: HighWrConfig = HIGH_WR_SUI_MOM_CONFIG,
): HighWrReport {
  const costs = cfg.costs ?? MAKER_COSTS;
  const trades: HighWrTrade[] = [];
  let tp1Count = 0;

  for (let i = cfg.lookback; i < candles.length - cfg.holdBars - 1; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0) continue;
    const window = candles.slice(i - cfg.lookback, i);
    const medVol = median(window.map((c) => c.volume));
    if (medVol <= 0) continue;
    const vZ = cur.volume / medVol;
    if (vZ < cfg.volMult) continue;
    const sd = stdReturns(window.map((c) => c.close));
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

    if (!passesFilters(candles, i, cfg, direction, ret)) continue;

    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const entry = entryBar.open;
    const tp1Level =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2Level =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let stopLevel =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);

    const maxExit = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1HitBar = -1;
    let leg2ExitPrice = candles[maxExit].close;
    let leg2ExitBar = maxExit;
    let exitReason: HighWrTrade["exitReason"] = "time";

    for (let j = i + 2; j <= maxExit; j++) {
      const bar = candles[j];
      const stopHit =
        direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
      const tp1Reached =
        direction === "long" ? bar.high >= tp1Level : bar.low <= tp1Level;
      const tp2Reached =
        direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;

      if (!tp1Hit) {
        if (tp1Reached && stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          exitReason = "stop";
          break;
        }
        if (stopHit) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          exitReason = "stop";
          break;
        }
        if (tp1Reached) {
          tp1Hit = true;
          tp1HitBar = j;
          if (cfg.useBreakeven) stopLevel = entry;
          if (tp2Reached) {
            leg2ExitBar = j;
            leg2ExitPrice = tp2Level;
            exitReason = "tp2";
            break;
          }
          continue;
        }
      } else {
        const stopHitNow =
          direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
        const tp2ReachedNow =
          direction === "long" ? bar.high >= tp2Level : bar.low <= tp2Level;
        if (tp2ReachedNow && stopHitNow) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          exitReason = "breakeven";
          break;
        }
        if (tp2ReachedNow) {
          leg2ExitBar = j;
          leg2ExitPrice = tp2Level;
          exitReason = "tp2";
          break;
        }
        if (stopHitNow) {
          leg2ExitBar = j;
          leg2ExitPrice = stopLevel;
          exitReason = "breakeven";
          break;
        }
      }
    }

    const leg2Cost = applyCosts({
      entry,
      exit: leg2ExitPrice,
      direction,
      holdingHours: leg2ExitBar - (i + 1),
      config: costs,
    });
    const leg2Pnl = leg2Cost.netPnlPct;
    let leg1Pnl: number;
    if (tp1Hit) {
      const leg1Cost = applyCosts({
        entry,
        exit: tp1Level,
        direction,
        holdingHours: tp1HitBar - (i + 1),
        config: costs,
      });
      leg1Pnl = leg1Cost.netPnlPct;
      tp1Count++;
    } else {
      leg1Pnl = leg2Pnl;
    }

    const totalPnl = 0.5 * leg1Pnl + 0.5 * leg2Pnl;
    trades.push({
      entryTime: entryBar.openTime,
      exitTime: candles[leg2ExitBar].openTime,
      direction,
      entry,
      tp1Hit,
      leg1Pnl,
      leg2Pnl,
      totalPnl,
      exitReason,
    });
    i = leg2ExitBar;
  }

  const returns = trades.map((t) => t.totalPnl);
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const wr = returns.length > 0 ? wins / returns.length : 0;
  const grossW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const grossL = Math.abs(
    returns.filter((r) => r < 0).reduce((s, v) => s + v, 0),
  );
  const pf = grossL > 0 ? grossW / grossL : returns.length > 0 ? 999 : 0;
  const m = returns.reduce((s, v) => s + v, 0) / Math.max(1, returns.length);
  const v =
    returns.reduce((s, x) => s + (x - m) * (x - m), 0) /
    Math.max(1, returns.length);
  const sd = Math.sqrt(v);
  const periodDays =
    trades.length > 0
      ? (trades[trades.length - 1].exitTime - trades[0].entryTime) / 86400000
      : 30;
  const perYear = periodDays > 0 ? (trades.length / periodDays) * 365 : 0;
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0;

  const equity = [1];
  for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
  let peak = 1,
    maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades,
    winRate: wr,
    netReturnPct: netRet,
    profitFactor: pf === Infinity ? 999 : pf,
    sharpe,
    maxDrawdownPct: maxDd,
    tp1HitRate: trades.length > 0 ? tp1Count / trades.length : 0,
  };
}

// ===========================================================================
// Live signal evaluator — "right now, is this strategy triggering?"
// ===========================================================================

export interface HighWrSnapshot {
  symbol: string;
  displayLabel: string;
  capturedAt: number;
  active: boolean;
  direction?: "long" | "short";
  vZ: number;
  pZ: number;
  threshold: { volMult: number; priceZ: number };
  filtersFailed: string[];
  entry?: number;
  tp1?: number;
  tp2?: number;
  stop?: number;
  holdUntil?: number;
  reason: string;
  stats: typeof HIGH_WR_SUI_MOM_STATS;
}

export function evaluateHighWrSignal(
  symbol: string,
  candles: Candle[],
  cfg: HighWrConfig = HIGH_WR_SUI_MOM_CONFIG,
): HighWrSnapshot {
  const now = Date.now();
  const base: Omit<
    HighWrSnapshot,
    "active" | "reason" | "vZ" | "pZ" | "filtersFailed"
  > & {
    active: false;
    reason: string;
    vZ: number;
    pZ: number;
    filtersFailed: string[];
  } = {
    symbol,
    displayLabel: `${symbol.replace("USDT", "")} (hi-WR scale-out)`,
    capturedAt: now,
    threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
    active: false,
    vZ: 0,
    pZ: 0,
    filtersFailed: [],
    stats: HIGH_WR_SUI_MOM_STATS,
    reason: "",
  };

  if (candles.length < cfg.lookback + 3) {
    return {
      ...base,
      reason: `Insufficient history (need ${cfg.lookback + 3}, have ${candles.length})`,
    };
  }

  const i = candles.length - 1;
  const cur = candles[i];
  const prev = candles[i - 1];
  if (prev.close <= 0) return { ...base, reason: "Previous close invalid" };

  const window = candles.slice(i - cfg.lookback, i);
  const medVol = median(window.map((c) => c.volume));
  const vZ = medVol > 0 ? cur.volume / medVol : 0;
  const sd = stdReturns(window.map((c) => c.close));
  const ret = (cur.close - prev.close) / prev.close;
  const pZ = sd > 0 ? Math.abs(ret) / sd : 0;

  if (vZ < cfg.volMult || pZ < cfg.priceZ) {
    return {
      ...base,
      vZ,
      pZ,
      reason: `No spike (vZ=${vZ.toFixed(2)}/${cfg.volMult}, pZ=${pZ.toFixed(2)}/${cfg.priceZ})`,
    };
  }

  const direction: "long" | "short" =
    cfg.mode === "fade"
      ? ret > 0
        ? "short"
        : "long"
      : ret > 0
        ? "long"
        : "short";

  const filtersFailed: string[] = [];
  if (cfg.avoidHoursUtc.length) {
    const h = new Date(cur.openTime).getUTCHours();
    if (cfg.avoidHoursUtc.includes(h)) filtersFailed.push(`hour ${h} UTC`);
  }
  if (cfg.htfTrend) {
    const smaVal = smaOf(
      candles.slice(Math.max(0, i - 23), i + 1).map((c) => c.close),
      24,
    );
    const alignedLong = cur.close > smaVal;
    if (direction === "long" && !alignedLong)
      filtersFailed.push("HTF trend (want up for long)");
    if (direction === "short" && alignedLong)
      filtersFailed.push("HTF trend (want down for short)");
  }
  if (cfg.microPullback) {
    const penult = candles[i - 1];
    const before = candles[i - 2];
    if (!penult || !before) {
      filtersFailed.push("micro-pullback history missing");
    } else if (cfg.mode === "momentum") {
      const hadPullback =
        direction === "long"
          ? penult.close < before.close
          : penult.close > before.close;
      if (!hadPullback) filtersFailed.push("no micro-pullback");
    } else {
      const sameDir =
        ret > 0 ? penult.close > before.close : penult.close < before.close;
      if (!sameDir) filtersFailed.push("no exhaustion pattern");
    }
  }

  if (filtersFailed.length > 0) {
    return {
      ...base,
      vZ,
      pZ,
      filtersFailed,
      reason: `Spike detected but filters failed: ${filtersFailed.join(", ")}`,
    };
  }

  const entry = cur.close;
  const tp1 =
    direction === "long" ? entry * (1 + cfg.tp1Pct) : entry * (1 - cfg.tp1Pct);
  const tp2 =
    direction === "long" ? entry * (1 + cfg.tp2Pct) : entry * (1 - cfg.tp2Pct);
  const stop =
    direction === "long"
      ? entry * (1 - cfg.stopPct)
      : entry * (1 + cfg.stopPct);
  const holdUntil = cur.closeTime + cfg.holdBars * 60 * 60 * 1000;

  return {
    symbol,
    displayLabel: `${symbol.replace("USDT", "")} (hi-WR scale-out)`,
    capturedAt: now,
    active: true,
    direction,
    vZ,
    pZ,
    threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
    filtersFailed: [],
    entry,
    tp1,
    tp2,
    stop,
    holdUntil,
    reason: `Trigger + all filters pass → ${direction.toUpperCase()} scale-out (tp1 ${(cfg.tp1Pct * 100).toFixed(2)}% / tp2 ${(cfg.tp2Pct * 100).toFixed(1)}% / BE stop)`,
    stats: HIGH_WR_SUI_MOM_STATS,
  };
}
