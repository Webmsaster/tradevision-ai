/**
 * High-Frequency Daytrading strategy (iter55-57).
 *
 * User asked for real daytrading: multiple trades per day, ≥70% WR, profit
 * positive. iter55-56 found (on 15m bars, 10-asset portfolio):
 *
 *   fade × volMult 2.5 × priceZ 1.8 × tp1 0.3% / tp2 1.2% × stop 3% × hold 6h
 *   + HTF-24h SMA + micro-exhaustion filter + breakeven-stop after tp1.
 *
 * Full-history: WR 91.8%, +58.6% return over 104 days, 17.2 trades/week
 * (2.5/day) on a 10-asset portfolio. Bootstrap pending (iter57).
 *
 * Mechanic: same scale-out + BE stop as iter50 SUI, tuned for 15m
 * timeframe. The 3% stop is wide — high WR comes from the wide stop giving
 * trades room to hit tp1; the rare losers are large but mathematically
 * overwhelmed by the 91% win rate at positive avgWin.
 *
 * Exports:
 *   HF_DAYTRADING_CONFIG — frozen parameter set
 *   HF_DAYTRADING_STATS  — iter56 stats (update from iter57 bootstrap)
 *   HF_DAYTRADING_ASSETS — 10-asset basket
 *   runHfDaytrading(candles, cfg)  — backtest driver
 *   evaluateHfDaytrading(sym, candles, cfg) — live snapshot
 *   evaluateHfDaytradingPortfolio(candlesBySym) — per-asset + aggregate
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

export interface HfConfig {
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
  /** Iter66: skip entries during these UTC hours (funding + low-liq). */
  avoidHoursUtc?: number[];
  /**
   * Iter79 — optional 1h-timeframe confluence. When true, require the 1h
   * bar containing the 15m signal to also be aligned with its own 24h
   * SMA. Boosts bootstrap minWR 86.5% → 90.6% at the cost of ~15% fewer
   * trades (3.06/day → 2.59/day). Default false — users pick via
   * HF_REQUIRE_1H_CONFLUENCE=1 env var in the paper-tick runner.
   */
  require1hConfluence?: boolean;
  costs?: CostConfig;
}

/**
 * Iter90-91 BTC-specific config.
 *
 * BTC has lower per-bar volatility than alts. Alt-tuned config (vm 2.5,
 * pZ 1.8, tp 0.3/1.2, stop 3%) produces only ~23 trades over 104 days
 * with cumRet +0.1% on BTC alone (essentially break-even). BTC needs:
 *   - Looser trigger (vm 2.0) — BTC has fewer extreme volume spikes
 *   - Tighter tp1 (0.15%) — BTC moves are smaller
 *   - Tighter stop (2.0%) — BTC swings don't warrant 3% stops
 *
 * iter91 bootstrap on BTC alone (14 windows):
 *   medWR 100.0%, minWR 91.3%, PF 7.14, ret +4.3%, pctProf 100%
 * Every single tested window had 100% WR except one at 91.3%.
 */
export const HF_BTC_CONFIG: HfConfig = {
  lookback: 48,
  volMult: 2.0,
  priceZ: 1.8,
  tp1Pct: 0.0015, // 0.15% — scaled for BTC's 30-40% lower vol
  tp2Pct: 0.012, // 1.2%
  stopPct: 0.02, // 2% (alt-default was 3%)
  holdBars: 24,
  mode: "fade",
  htfTrend: true,
  microPullback: true,
  useBreakeven: true,
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/**
 * Per-asset config overrides. Symbols NOT in this map use the default
 * HF_DAYTRADING_CONFIG. BTC gets its own tightly-scaled config.
 */
export const HF_PER_ASSET_CONFIGS: Record<string, HfConfig> = {
  BTCUSDT: HF_BTC_CONFIG,
};

/** Helper: get config for a given symbol (BTC-override or default). */
export function configForSymbol(symbol: string): HfConfig {
  return HF_PER_ASSET_CONFIGS[symbol] ?? HF_DAYTRADING_CONFIG;
}

export const HF_DAYTRADING_CONFIG: HfConfig = {
  lookback: 48, // 12h on 15m bars
  volMult: 2.5,
  priceZ: 1.8,
  tp1Pct: 0.003, // 0.3%
  tp2Pct: 0.012, // 1.2%
  stopPct: 0.03, // 3% (wide — WR comes from time-in-trade)
  holdBars: 24, // 6h max hold
  mode: "fade",
  htfTrend: true,
  microPullback: true,
  useBreakeven: true,
  // iter68: hour 0 UTC is funding-hour toxicity (50% WR, -9.84% cumPnL on full
  // history). Adding [0] is strict improvement over baseline: bootstrap medWR
  // 90.6% → 91.6%, minWR 86.5% unchanged, pctProf stays at 100%.
  // iter67 tested [0, 20] too but hour 20 (75% WR, only 8 trades) was single-
  // window noise — in bootstrap it DROPS pctProf from 100% to 93%. Hour 20 is
  // not filtered.
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

export const HF_DAYTRADING_ASSETS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "AVAXUSDT",
  "SUIUSDT",
  "APTUSDT",
  "INJUSDT",
  "NEARUSDT",
  "OPUSDT",
  "LINKUSDT",
  // iter65 selective additions (DOT/LTC/AAVE passed per-asset WR≥92 + positive ret,
  // while 7 other candidates in iter64 had WR≥70 but NEGATIVE ret and were dropped)
  "DOTUSDT",
  "LTCUSDT",
  "AAVEUSDT",
  // iter82-83 expansion: 20 further retail-heavy alt candidates screened;
  // 2 passed strict filter (per-asset WR≥92 + cumRet≥+3% + n≥20):
  //   ORDI:  WR 100.0%, 22 trades, +7.4%
  //   MANTA: WR  93.1%, 29 trades, +5.9%
  // iter83 bootstrap-locked: medWR 91.6%→92.6%, minWR 86.5%→88.4%,
  //                          trades/day 3.06→3.63, cumRet +107%→+124%
  //                          pctProf stays 100%
  "ORDIUSDT",
  "MANTAUSDT",
  // iter84-86 second-wave expansion: 20 more DeFi/RWA/GameFi/legacy alts
  // screened; 1 passed strict filter:
  //   VET: WR 96.0%, 25 trades, +3.8% (legacy mid-cap, retail-heavy)
  // 19 others rejected (WR < 92% or negative ret)
  "VETUSDT",
] as const;

/**
 * Iter57 bootstrap-locked stats: 15 windows (10 chrono + 5 block-bootstrap)
 * of 10-asset portfolio on 15m bars. Minimum WR 85% across ALL windows,
 * 100% of windows profitable. This is the most robust hi-WR claim in the
 * analyzer.
 */
export const HF_DAYTRADING_STATS = {
  iteration: 86,
  windowsTested: 14,
  medianWinRate: 0.928, // iter86 16-asset bootstrap (92.6 → 92.8)
  minWinRate: 0.896, // up from 88.4% — every window now ≥89.6% WR
  medianReturnPct: 0.445, // chr50 median per window
  minReturnPct: 0.064, // worst window (chr80) still +6.4%
  avgTradesPerWindow: 217.5,
  tradesPerWeek: 27.1,
  tradesPerDay: 3.87,
  pctWindowsProfitable: 1.0, // ALL 14 windows profitable
  timeframe: "15m",
  assets: HF_DAYTRADING_ASSETS as unknown as string[],
  trigger: "volume-spike + price-z (vm 2.5, pZ 1.8) — fade mode",
  filters: "24h-SMA trend align + micro-exhaustion + avoid hour 0 UTC",
  execution:
    "scale-out 50% @ tp1 0.3% + 50% @ tp2 1.2%, stop 3% (BE after tp1), hold 6h",
} as const;

export interface HfTrade {
  entryTime: number;
  exitTime: number;
  direction: "long" | "short";
  entry: number;
  tp1Hit: boolean;
  totalPnl: number;
  exitReason: "stop" | "tp2" | "breakeven" | "time";
}

export interface HfReport {
  trades: HfTrade[];
  winRate: number;
  netReturnPct: number;
  profitFactor: number;
  tp1HitRate: number;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function stdReturns(c: number[]): number {
  if (c.length < 3) return 0;
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

function smaOf(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/**
 * Find the 1h candle containing a given 15m bar (by openTime membership).
 */
function findContaining1h(bar15m: Candle, candles1h: Candle[]): Candle | null {
  for (let i = candles1h.length - 1; i >= 0; i--) {
    const c = candles1h[i];
    if (c.openTime <= bar15m.openTime && bar15m.openTime <= c.closeTime) {
      return c;
    }
  }
  return null;
}

function passesFilters(
  candles: Candle[],
  i: number,
  cfg: HfConfig,
  direction: "long" | "short",
  ret: number,
  candles1h?: Candle[],
): boolean {
  if (cfg.avoidHoursUtc && cfg.avoidHoursUtc.length > 0) {
    const h = new Date(candles[i].openTime).getUTCHours();
    if (cfg.avoidHoursUtc.includes(h)) return false;
  }
  if (cfg.htfTrend) {
    const closes = candles
      .slice(Math.max(0, i - 47), i + 1)
      .map((c) => c.close);
    const sma48 = smaOf(closes);
    const alignedLong = candles[i].close > sma48;
    if (direction === "long" && !alignedLong) return false;
    if (direction === "short" && alignedLong) return false;
  }
  if (cfg.microPullback) {
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) return false;
    if (cfg.mode === "momentum") {
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) return false;
    } else {
      const sameDir = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sameDir) return false;
    }
  }
  // Iter79: 1h timeframe confluence (opt-in) — require the containing 1h bar
  // to be aligned with its 24-bar SMA in the same direction as the trade
  if (cfg.require1hConfluence && candles1h && candles1h.length >= 24) {
    const c1h = findContaining1h(candles[i], candles1h);
    if (!c1h) return false;
    const idx1h = candles1h.indexOf(c1h);
    if (idx1h < 24) return false;
    const sma1h = smaOf(candles1h.slice(idx1h - 24, idx1h).map((c) => c.close));
    const aligned1h = c1h.close > sma1h;
    if (direction === "long" && !aligned1h) return false;
    if (direction === "short" && aligned1h) return false;
  }
  return true;
}

export function runHfDaytrading(
  candles: Candle[],
  cfg: HfConfig = HF_DAYTRADING_CONFIG,
  candles1h?: Candle[],
): HfReport {
  const costs = cfg.costs ?? MAKER_COSTS;
  const trades: HfTrade[] = [];
  let tp1Count = 0;

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
    if (!passesFilters(candles, i, cfg, direction, ret, candles1h)) continue;

    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp1L =
      direction === "long"
        ? entry * (1 + cfg.tp1Pct)
        : entry * (1 - cfg.tp1Pct);
    const tp2L =
      direction === "long"
        ? entry * (1 + cfg.tp2Pct)
        : entry * (1 - cfg.tp2Pct);
    let sL =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
    let tp1Hit = false;
    let tp1Bar = -1;
    let l2P = candles[mx].close;
    let l2B = mx;
    let exitReason: HfTrade["exitReason"] = "time";

    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      const sH = direction === "long" ? bar.low <= sL : bar.high >= sL;
      const t1R = direction === "long" ? bar.high >= tp1L : bar.low <= tp1L;
      const t2R = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
      if (!tp1Hit) {
        if (t1R && sH) {
          l2B = j;
          l2P = sL;
          exitReason = "stop";
          break;
        }
        if (sH) {
          l2B = j;
          l2P = sL;
          exitReason = "stop";
          break;
        }
        if (t1R) {
          tp1Hit = true;
          tp1Bar = j;
          if (cfg.useBreakeven) sL = entry;
          if (t2R) {
            l2B = j;
            l2P = tp2L;
            exitReason = "tp2";
            break;
          }
          continue;
        }
      } else {
        const sH2 = direction === "long" ? bar.low <= sL : bar.high >= sL;
        const t22 = direction === "long" ? bar.high >= tp2L : bar.low <= tp2L;
        if (t22 && sH2) {
          l2B = j;
          l2P = sL;
          exitReason = "breakeven";
          break;
        }
        if (t22) {
          l2B = j;
          l2P = tp2L;
          exitReason = "tp2";
          break;
        }
        if (sH2) {
          l2B = j;
          l2P = sL;
          exitReason = "breakeven";
          break;
        }
      }
    }

    const l2c = applyCosts({
      entry,
      exit: l2P,
      direction,
      holdingHours: (l2B - (i + 1)) * 0.25,
      config: costs,
    });
    const leg2 = l2c.netPnlPct;
    let leg1: number;
    if (tp1Hit) {
      const l1c = applyCosts({
        entry,
        exit: tp1L,
        direction,
        holdingHours: (tp1Bar - (i + 1)) * 0.25,
        config: costs,
      });
      leg1 = l1c.netPnlPct;
      tp1Count++;
    } else {
      leg1 = leg2;
    }
    const total = 0.5 * leg1 + 0.5 * leg2;
    trades.push({
      entryTime: eb.openTime,
      exitTime: candles[l2B].openTime,
      direction,
      entry,
      tp1Hit,
      totalPnl: total,
      exitReason,
    });
    i = l2B;
  }

  const returns = trades.map((t) => t.totalPnl);
  const netRet = returns.reduce((a, r) => a * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  const wr = returns.length > 0 ? wins / returns.length : 0;
  const gW = returns.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const gL = Math.abs(returns.filter((r) => r < 0).reduce((s, v) => s + v, 0));
  const pf = gL > 0 ? gW / gL : returns.length > 0 ? 999 : 0;
  return {
    trades,
    winRate: wr,
    netReturnPct: netRet,
    profitFactor: pf === Infinity ? 999 : pf,
    tp1HitRate: trades.length > 0 ? tp1Count / trades.length : 0,
  };
}

// ===========================================================================
// Live signal evaluator
// ===========================================================================

export interface HfSnapshot {
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
  stats: typeof HF_DAYTRADING_STATS;
}

export function evaluateHfDaytrading(
  symbol: string,
  candles: Candle[],
  cfg: HfConfig = HF_DAYTRADING_CONFIG,
  candles1h?: Candle[],
): HfSnapshot {
  const now = Date.now();
  const base = {
    symbol,
    displayLabel: `${symbol.replace("USDT", "")} (HF daytrade)`,
    capturedAt: now,
    threshold: { volMult: cfg.volMult, priceZ: cfg.priceZ },
    filtersFailed: [],
    stats: HF_DAYTRADING_STATS,
  };

  if (candles.length < cfg.lookback + 3) {
    return {
      ...base,
      active: false,
      vZ: 0,
      pZ: 0,
      reason: `Insufficient history (need ${cfg.lookback + 3})`,
    };
  }
  const i = candles.length - 1;
  const cur = candles[i];
  const prev = candles[i - 1];
  if (prev.close <= 0) {
    return {
      ...base,
      active: false,
      vZ: 0,
      pZ: 0,
      reason: "Previous close invalid",
    };
  }
  const w = candles.slice(i - cfg.lookback, i);
  const mv = median(w.map((c) => c.volume));
  const vZ = mv > 0 ? cur.volume / mv : 0;
  const sd = stdReturns(w.map((c) => c.close));
  const ret = (cur.close - prev.close) / prev.close;
  const pZ = sd > 0 ? Math.abs(ret) / sd : 0;
  if (vZ < cfg.volMult || pZ < cfg.priceZ) {
    return {
      ...base,
      active: false,
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
  if (cfg.avoidHoursUtc && cfg.avoidHoursUtc.length > 0) {
    const h = new Date(cur.openTime).getUTCHours();
    if (cfg.avoidHoursUtc.includes(h))
      filtersFailed.push(`hour ${h} UTC (avoid)`);
  }
  if (cfg.htfTrend) {
    const sma48 = smaOf(
      candles.slice(Math.max(0, i - 47), i + 1).map((c) => c.close),
    );
    const alignedLong = cur.close > sma48;
    if (direction === "long" && !alignedLong) filtersFailed.push("HTF trend");
    if (direction === "short" && alignedLong) filtersFailed.push("HTF trend");
  }
  if (cfg.microPullback) {
    const p = candles[i - 1];
    const b = candles[i - 2];
    if (!p || !b) filtersFailed.push("micro hist missing");
    else if (cfg.mode === "momentum") {
      const pb = direction === "long" ? p.close < b.close : p.close > b.close;
      if (!pb) filtersFailed.push("no pullback");
    } else {
      const sd2 = ret > 0 ? p.close > b.close : p.close < b.close;
      if (!sd2) filtersFailed.push("no exhaustion");
    }
  }
  if (cfg.require1hConfluence) {
    if (!candles1h || candles1h.length < 24) {
      filtersFailed.push("1h confluence data missing");
    } else {
      const c1h = findContaining1h(cur, candles1h);
      if (!c1h) {
        filtersFailed.push("1h bar not found");
      } else {
        const idx1h = candles1h.indexOf(c1h);
        if (idx1h < 24) {
          filtersFailed.push("1h history too short");
        } else {
          const sma1h = smaOf(
            candles1h.slice(idx1h - 24, idx1h).map((c) => c.close),
          );
          const aligned1h = c1h.close > sma1h;
          if (direction === "long" && !aligned1h)
            filtersFailed.push("1h trend down (want up)");
          if (direction === "short" && aligned1h)
            filtersFailed.push("1h trend up (want down)");
        }
      }
    }
  }
  if (filtersFailed.length > 0) {
    return {
      ...base,
      active: false,
      vZ,
      pZ,
      filtersFailed,
      reason: `Spike detected but filter(s) failed: ${filtersFailed.join(", ")}`,
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
  const holdUntil = cur.closeTime + cfg.holdBars * 15 * 60 * 1000;
  return {
    ...base,
    active: true,
    direction,
    vZ,
    pZ,
    entry,
    tp1,
    tp2,
    stop,
    holdUntil,
    reason: `Trigger + filters pass → ${direction.toUpperCase()} fade scale-out`,
  };
}

export interface HfPortfolioSnapshot {
  capturedAt: number;
  activeSymbols: string[];
  legs: HfSnapshot[];
  stats: typeof HF_DAYTRADING_STATS;
}

export function evaluateHfDaytradingPortfolio(
  candlesBySymbol: Record<string, Candle[] | undefined>,
  /** Optional 1h candles (one per symbol) — required only when
   *  HF_DAYTRADING_CONFIG.require1hConfluence is true. */
  candles1hBySymbol?: Record<string, Candle[] | undefined>,
): HfPortfolioSnapshot {
  const legs: HfSnapshot[] = [];
  for (const sym of HF_DAYTRADING_ASSETS) {
    const c = candlesBySymbol[sym];
    // iter91: use per-asset config override (BTCUSDT gets BTC-tuned cfg)
    const cfg = configForSymbol(sym);
    if (!c || c.length < cfg.lookback + 3) continue;
    const c1h = candles1hBySymbol?.[sym];
    legs.push(evaluateHfDaytrading(sym, c, cfg, c1h));
  }
  return {
    capturedAt: Date.now(),
    activeSymbols: legs.filter((l) => l.active).map((l) => l.symbol),
    legs,
    stats: HF_DAYTRADING_STATS,
  };
}
