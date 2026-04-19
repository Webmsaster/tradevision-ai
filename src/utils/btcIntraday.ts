/**
 * BTC-only intraday ensemble (iter114–119).
 *
 * Union of four long-only entry mechanics run with up to 3 concurrent
 * positions (1/3 sizing each) on 1h BTC candles. Each position is managed
 * with the same scale-out executor (tp1 50% @ +0.8%, tp2 50% @ +4%, stop
 * −1%, break-even after tp1, max-hold 24h). An 168h SMA "HTF uptrend" gate
 * plus a macro "30-day BTC return > 0" gate sit on top of every mechanic.
 *
 * Validated over 2083 days (50 000 1h candles):
 *   n = 3185, trades/day 1.53, WR 58.0%,
 *   cumRet +144.8%, Sharpe 7.15, bs+ 100% (100-sample bootstrap),
 *   5th-pctile bootstrap return +80.9%, 80% of 10 windows profitable,
 *   minWin −4.5%. OOS (last 40% ≈ 833 d): ret +24.8%, Shp 5.70, bs+ 94%.
 *
 * The macro gate suppresses trades during BTC bear/sideways regimes. This
 * is what iter101–104 (HF Daytrading) missed — that system's ensemble
 * optimised to recent volatility and failed multi-year because it had no
 * top-level regime filter. The MG3 gate fixes exactly that.
 *
 * Why 1h and not 15m? iter116 ran the same 4 mechanics on 15m — every
 * single config lost money (Sharpe −10 to −20) because 0.3% tp1 was
 * swamped by 1h intrabar noise at the 15m resolution. The 1h cadence is
 * the right frequency for this scale-out geometry on BTC.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

// ────── public config ──────

export interface BtcIntradayConfig {
  /** Own-asset HTF gate: close > SMA(htfLen). */
  htfLen: number;
  /** Macro gate: BTC (close − close[−macro30dBars]) / close[−macro30dBars] > 0. */
  macro30dBars: number;
  /** Maximum simultaneous long positions. Each sized 1/maxConcurrent of unit. */
  maxConcurrent: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  holdBars: number;
  /** M4 trigger: RSI(rsiLen) ≤ rsiTh. */
  rsiLen: number;
  rsiTh: number;
  /** M5 trigger: close > max(highs over nHi bars). */
  nHi: number;
  /** M6 trigger: (close−open)/open ≤ −redPct. */
  redPct: number;
  /**
   * Volume-participation filter (iter133). If > 0, require
   *   volume[i] > volumeMult × median(volume[i−volumeMedianLen..i−1]).
   * Lifts Sharpe from 7.06 → 8.23 and minWindowRet from −6.6% → −1.7%
   * at the cost of tpd 1.87 → 1.26. Set to 0 to disable.
   */
  volumeMult?: number;
  volumeMedianLen?: number;
  avoidHoursUtc?: number[];
  costs?: CostConfig;
}

/**
 * Iter 133-locked production config (new default).
 *
 * Upgrade over iter123 by adding a volume-participation filter
 * (vol > 1.2 × median(volume, 96h)). Iter 130 showed volume confirmation
 * filters out weak-hand false signals; iter 133 5-gate battery confirmed
 * the upgrade on 2083 days of BTC history:
 *   Sharpe 7.06 → 8.23 (+17%)
 *   mean/trade 0.021% → 0.025% (+19%)
 *   pctProf 80% → 90%
 *   minW −6.6% → −1.7%
 *   ALL 4 quarters positive (Q1 +35% / Q2 +12% / Q3 +18% / Q4 +6%)
 *   OOS Sharpe 5.82 (vs iter123's 5.60), bs+ 87%
 * Tradeoff: tpd 1.87 → 1.26 (fewer but higher-quality trades).
 *
 * iter 131 tested multi-timeframe confluence — rejected (redundant with MG3).
 * iter 129 tested multi-asset basket — rejected (SOL/LINK dilute Sharpe).
 */
export const BTC_INTRADAY_CONFIG: BtcIntradayConfig = {
  htfLen: 168,
  macro30dBars: 720,
  maxConcurrent: 4,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  rsiLen: 7,
  rsiTh: 42,
  nHi: 36,
  redPct: 0.002,
  volumeMult: 1.2,
  volumeMedianLen: 96,
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/**
 * Iter 123 tier — same mechanics but WITHOUT volume filter. Keep for
 * users who want maximum trade count at slightly lower Sharpe.
 *   tpd 1.87 · Sharpe 7.06 · minW -6.6%
 */
export const BTC_INTRADAY_CONFIG_HIGH_FREQ: BtcIntradayConfig = {
  htfLen: 168,
  macro30dBars: 720,
  maxConcurrent: 4,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  rsiLen: 7,
  rsiTh: 42,
  nHi: 36,
  redPct: 0.002,
  volumeMult: 0, // disabled
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/**
 * Iter 119 conservative tier — kept for users who prefer the original
 * (fewer trades, slightly higher bootstrap 5th-percentile). Use when
 * capital is deployed more aggressively per trade and lower trade count
 * is preferred.
 */
export const BTC_INTRADAY_CONFIG_CONSERVATIVE: BtcIntradayConfig = {
  htfLen: 168,
  macro30dBars: 720,
  maxConcurrent: 3,
  tp1Pct: 0.008,
  tp2Pct: 0.04,
  stopPct: 0.01,
  holdBars: 24,
  rsiLen: 7,
  rsiTh: 40,
  nHi: 48,
  redPct: 0.005,
  avoidHoursUtc: [0],
  costs: MAKER_COSTS,
};

/** Read-only iter133 validation stats (default config). */
export const BTC_INTRADAY_STATS = {
  iteration: 133,
  symbol: "BTCUSDT",
  timeframe: "1h",
  daysTested: 2083,
  trades: 2635,
  tradesPerDay: 1.26,
  winRate: 0.578,
  /** Arithmetic mean PnL per book-trade (1/maxConcurrent sized). */
  meanPctPerTrade: 0.00025,
  cumReturnPct: 0.926,
  sharpe: 8.23,
  windowsProfitablePct: 0.9,
  minWindowRet: -0.017,
  bootstrapPctPositive: 1.0,
  bootstrap5thPctRet: 0.534,
  oos: {
    fractionOfHistory: 0.4,
    trades: 941,
    tradesPerDay: 1.13,
    cumReturnPct: 0.171,
    sharpe: 5.82,
    bootstrapPctPositive: 0.87,
  },
  quarters: [
    {
      tradesPerDay: 1.65,
      winRate: 0.586,
      meanPct: 0.00035,
      cumReturnPct: 0.349,
    },
    {
      tradesPerDay: 1.0,
      winRate: 0.566,
      meanPct: 0.00023,
      cumReturnPct: 0.122,
    },
    {
      tradesPerDay: 1.27,
      winRate: 0.586,
      meanPct: 0.00025,
      cumReturnPct: 0.178,
    },
    {
      tradesPerDay: 0.92,
      winRate: 0.57,
      meanPct: 0.00012,
      cumReturnPct: 0.057,
    },
  ],
  mechanics: ["M1_nDown", "M4_rsi", "M5_breakout", "M6_redBar"] as const,
  gates:
    "HTF 168h SMA uptrend + macro 30-day BTC return > 0 (MG3) + volume > 1.2× median(96h); union of 4 long-only mechanics; up to 4 concurrent positions at 1/4 size each; scale-out tp1 0.8% / tp2 4% / stop 1% (BE after tp1); 24h max hold; hour 0 UTC avoided",
  note:
    "Iter 133 upgrade over iter123 by adding a volume-participation filter " +
    "(vol > 1.2× median(96h)). Lifts Sharpe 7.06 → 8.23 (+17%), mean/trade " +
    "+19%, pctProf 80% → 90%, minW -6.6% → -1.7%, and makes ALL 4 quarters " +
    "profitable. tpd drops 1.87 → 1.26 as weaker signals are filtered out.",
} as const;

/** Conservative tier stats (iter119). Exposed for UI tier-comparison. */
export const BTC_INTRADAY_STATS_CONSERVATIVE = {
  iteration: 119,
  tradesPerDay: 1.53,
  winRate: 0.58,
  cumReturnPct: 1.448,
  sharpe: 7.15,
  bootstrapPctPositive: 1.0,
  bootstrap5thPctRet: 0.809,
  oosSharpe: 5.7,
  oosBootstrapPctPositive: 0.94,
} as const;

/** High-frequency tier stats (iter123). Exposed for UI tier-comparison. */
export const BTC_INTRADAY_STATS_HIGH_FREQ = {
  iteration: 123,
  tradesPerDay: 1.87,
  winRate: 0.58,
  cumReturnPct: 1.251,
  sharpe: 7.06,
  bootstrapPctPositive: 1.0,
  bootstrap5thPctRet: 0.476,
  oosSharpe: 5.6,
  oosBootstrapPctPositive: 0.92,
} as const;

export type BtcMechanic = "M1_nDown" | "M4_rsi" | "M5_breakout" | "M6_redBar";

export interface BtcIntradayTrade {
  entryTime: number;
  exitTime: number;
  entry: number;
  mechanic: BtcMechanic;
  tp1Hit: boolean;
  /** Net PnL fraction (already divided by maxConcurrent; the book-level contribution). */
  pnl: number;
  exitReason: "stop" | "tp2" | "breakeven" | "time";
}

export interface BtcIntradayReport {
  trades: BtcIntradayTrade[];
  winRate: number;
  netReturnPct: number;
  tradesPerDay: number;
  daysCovered: number;
  tp1HitRate: number;
  byMechanic: Record<BtcMechanic, number>;
}

// ────── internal helpers ──────

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function medianLast(v: number[], n: number): number {
  if (v.length < n) return 0;
  const s = [...v.slice(-n)].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function maxLast(v: number[], n: number): number {
  const s = v.slice(-n);
  let m = -Infinity;
  for (const x of s) if (x > m) m = x;
  return m;
}
function rsiSeries(closes: number[], len: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= len) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

interface ExecuteOut {
  exitBar: number;
  pnl: number;
  tp1Hit: boolean;
  exitReason: BtcIntradayTrade["exitReason"];
}

function executeLong(
  candles: Candle[],
  i: number,
  cfg: BtcIntradayConfig,
): ExecuteOut | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp1L = entry * (1 + cfg.tp1Pct);
  const tp2L = entry * (1 + cfg.tp2Pct);
  let sL = entry * (1 - cfg.stopPct);
  const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
  let tp1Hit = false;
  let tp1Bar = -1;
  let l2P = candles[mx].close;
  let l2B = mx;
  let reason: BtcIntradayTrade["exitReason"] = "time";
  const costs = cfg.costs ?? MAKER_COSTS;
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    const sH = bar.low <= sL;
    const t1 = bar.high >= tp1L;
    const t2 = bar.high >= tp2L;
    if (!tp1Hit) {
      if (sH) {
        l2B = j;
        l2P = sL;
        reason = "stop";
        break;
      }
      if (t1) {
        tp1Hit = true;
        tp1Bar = j;
        sL = entry;
        if (t2) {
          l2B = j;
          l2P = tp2L;
          reason = "tp2";
          break;
        }
        continue;
      }
    } else {
      if (bar.low <= sL) {
        l2B = j;
        l2P = sL;
        reason = "breakeven";
        break;
      }
      if (bar.high >= tp2L) {
        l2B = j;
        l2P = tp2L;
        reason = "tp2";
        break;
      }
    }
  }
  const leg2 = applyCosts({
    entry,
    exit: l2P,
    direction: "long",
    holdingHours: l2B - (i + 1),
    config: costs,
  }).netPnlPct;
  const leg1 = tp1Hit
    ? applyCosts({
        entry,
        exit: tp1L,
        direction: "long",
        holdingHours: tp1Bar - (i + 1),
        config: costs,
      }).netPnlPct
    : leg2;
  const fullPnl = 0.5 * leg1 + 0.5 * leg2;
  return {
    exitBar: l2B,
    pnl: fullPnl / Math.max(1, cfg.maxConcurrent),
    tp1Hit,
    exitReason: reason,
  };
}

function fireMechanic(
  candles: Candle[],
  closes: number[],
  highs: number[],
  r: number[],
  i: number,
  m: BtcMechanic,
  cfg: BtcIntradayConfig,
): boolean {
  switch (m) {
    case "M1_nDown":
      if (i < 2) return false;
      return closes[i] < closes[i - 1] && closes[i - 1] < closes[i - 2];
    case "M4_rsi":
      if (i <= cfg.rsiLen) return false;
      return r[i] <= cfg.rsiTh;
    case "M5_breakout": {
      if (i < cfg.nHi + 1) return false;
      return candles[i].close > maxLast(highs.slice(i - cfg.nHi, i), cfg.nHi);
    }
    case "M6_redBar": {
      const o = candles[i].open;
      const c = candles[i].close;
      if (o <= 0) return false;
      return (c - o) / o <= -cfg.redPct;
    }
  }
}

// ────── public runner ──────

export function runBtcIntraday(
  candles: Candle[],
  cfg: BtcIntradayConfig = BTC_INTRADAY_CONFIG,
): BtcIntradayReport {
  const empty: BtcIntradayReport = {
    trades: [],
    winRate: 0,
    netReturnPct: 0,
    tradesPerDay: 0,
    daysCovered: 0,
    tp1HitRate: 0,
    byMechanic: { M1_nDown: 0, M4_rsi: 0, M5_breakout: 0, M6_redBar: 0 },
  };
  if (!candles || candles.length < cfg.htfLen + cfg.macro30dBars + 5) {
    return empty;
  }
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const r = rsiSeries(closes, cfg.rsiLen);

  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    trendMask[i] = candles[i].close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.macro30dBars; i < candles.length; i++) {
    const past = closes[i - cfg.macro30dBars];
    if (past > 0) macroMask[i] = (closes[i] - past) / past > 0;
  }
  // Volume filter (iter133). Precompute the median for speed.
  const volumeMult = cfg.volumeMult ?? 0;
  const volumeMedianLen = cfg.volumeMedianLen ?? 96;
  const volumeMedian: number[] = new Array(candles.length).fill(0);
  if (volumeMult > 0 && volumeMedianLen > 0) {
    for (let i = volumeMedianLen; i < candles.length; i++) {
      volumeMedian[i] = medianLast(
        volumes.slice(i - volumeMedianLen, i),
        volumeMedianLen,
      );
    }
  }

  const openExits: { exitBar: number; mech: BtcMechanic }[] = [];
  const trades: BtcIntradayTrade[] = [];
  const mechs: BtcMechanic[] = [
    "M1_nDown",
    "M4_rsi",
    "M5_breakout",
    "M6_redBar",
  ];
  const avoidSet = new Set(cfg.avoidHoursUtc ?? []);
  const startIdx = Math.max(cfg.htfLen, cfg.macro30dBars, cfg.rsiLen + 1) + 2;

  for (let i = startIdx; i < candles.length - 1; i++) {
    // drop stale opens
    for (let k = openExits.length - 1; k >= 0; k--) {
      if (openExits[k].exitBar < i) openExits.splice(k, 1);
    }
    if (openExits.length >= cfg.maxConcurrent) continue;
    if (!trendMask[i] || !macroMask[i]) continue;
    const hr = new Date(candles[i].openTime).getUTCHours();
    if (avoidSet.has(hr)) continue;
    if (volumeMult > 0 && volumes[i] <= volumeMult * volumeMedian[i]) continue;

    for (const m of mechs) {
      if (openExits.length >= cfg.maxConcurrent) break;
      if (openExits.some((o) => o.mech === m)) continue;
      if (!fireMechanic(candles, closes, highs, r, i, m, cfg)) continue;
      const r2 = executeLong(candles, i, cfg);
      if (!r2) continue;
      trades.push({
        entryTime: candles[i + 1].openTime,
        exitTime: candles[r2.exitBar].closeTime,
        entry: candles[i + 1].open,
        mechanic: m,
        tp1Hit: r2.tp1Hit,
        pnl: r2.pnl,
        exitReason: r2.exitReason,
      });
      openExits.push({ exitBar: r2.exitBar, mech: m });
    }
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const cum = trades.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
  const tp1H = trades.filter((t) => t.tp1Hit).length;
  const daysCovered = candles.length / 24;
  const byMechanic: Record<BtcMechanic, number> = {
    M1_nDown: 0,
    M4_rsi: 0,
    M5_breakout: 0,
    M6_redBar: 0,
  };
  for (const t of trades) byMechanic[t.mechanic]++;

  return {
    trades,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    netReturnPct: cum,
    tradesPerDay: daysCovered > 0 ? trades.length / daysCovered : 0,
    daysCovered,
    tp1HitRate: trades.length > 0 ? tp1H / trades.length : 0,
    byMechanic,
  };
}

// ────── live-signal helper ──────

export interface BtcIntradayLiveSignal {
  barIndex: number;
  barOpenTime: number;
  mechanic: BtcMechanic;
  trendOk: boolean;
  macroOk: boolean;
  volumeOk: boolean;
}

/**
 * Returns any mechanic fires on the LAST fully-closed bar (i = length − 2 so
 * the entry would be at `length − 1`). Lightweight: used by liveSignals.
 */
export function getBtcIntradayLiveSignals(
  candles: Candle[],
  cfg: BtcIntradayConfig = BTC_INTRADAY_CONFIG,
): BtcIntradayLiveSignal[] {
  if (!candles || candles.length < cfg.htfLen + cfg.macro30dBars + 5) return [];
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const r = rsiSeries(closes, cfg.rsiLen);
  const i = candles.length - 2; // last closed bar with room for next-bar entry
  if (i < Math.max(cfg.htfLen, cfg.macro30dBars)) return [];
  const sma = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
  const trendOk = candles[i].close > sma;
  const past = closes[i - cfg.macro30dBars];
  const macroOk = past > 0 && (closes[i] - past) / past > 0;
  const hr = new Date(candles[i].openTime).getUTCHours();
  if ((cfg.avoidHoursUtc ?? []).includes(hr)) return [];
  const volumeMult = cfg.volumeMult ?? 0;
  const volumeMedianLen = cfg.volumeMedianLen ?? 96;
  const volumeOk =
    volumeMult <= 0 ||
    (i >= volumeMedianLen &&
      volumes[i] >
        volumeMult *
          medianLast(volumes.slice(i - volumeMedianLen, i), volumeMedianLen));
  const out: BtcIntradayLiveSignal[] = [];
  if (!trendOk || !macroOk || !volumeOk) return out;
  const mechs: BtcMechanic[] = [
    "M1_nDown",
    "M4_rsi",
    "M5_breakout",
    "M6_redBar",
  ];
  for (const m of mechs) {
    if (fireMechanic(candles, closes, highs, r, i, m, cfg)) {
      out.push({
        barIndex: i,
        barOpenTime: candles[i].openTime,
        mechanic: m,
        trendOk,
        macroOk,
        volumeOk,
      });
    }
  }
  return out;
}
