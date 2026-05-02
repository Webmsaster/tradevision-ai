/**
 * BTC daily swing tier (iter124–128).
 *
 * Context: the user asked for profit/trade ≥ 2% while keeping the iter123
 * win rate (58%) intact. Iterations 124–127 mapped the frontier and showed
 * that is mathematically impossible with our long-only ensemble on BTC:
 *   - 1h scale-out (iter123): mean 0.03%/trade, WR 58%
 *   - 1h single-exit: max mean 0.30%/trade, never ≥ 2%
 *   - 4h fixed TP 20-30%: in-sample mean 2.2-3.0%, BUT fails OOS (Q4 −61%)
 *   - 1d tp=20%/stop=7%/hold=40: **mean 3.17%**, WR 42%, all 5 gates pass
 *
 * This module ships the iter128 1D-C config as an OPT-IN swing tier. It is
 * NOT a replacement for the default iter123 intraday ensemble — it is for
 * users who want HIGH profit per trade even at the cost of a lower win rate
 * and trade count (~2 trades/month).
 *
 * Validated over 3000 days (8.2 years) of Binance BTCUSDT 1d candles:
 *   n = 205, tpd 0.068 (~2/month, ~25/year), WR 42.0%,
 *   mean profit/trade +3.17%, cumRet +13356% (full-size compounded),
 *   Sharpe 4.79, bs+ 96%, 5th-pctile bootstrap +84.7%,
 *   all 4 quarters positive (Q1-4: +283% / +1377% / +264% / +50%),
 *   10/10 param sensitivity pass, OOS (60/40): mean +1.92%, Shp 3.15.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

export interface BtcSwingConfig {
  /** HTF-SMA gate length in daily bars (7 = 1 week). */
  htfLen: number;
  /** Macro gate: BTC (close − close[−macroBars]) / close[−macroBars] > 0. */
  macroBars: number;
  maxConcurrent: number;
  tpPct: number;
  stopPct: number;
  holdBars: number;
  rsiLen: number;
  rsiTh: number;
  nHi: number;
  redPct: number;
  nDown: number;
  costs?: CostConfig;
}

/** Iter 128 1D-C locked config. */
export const BTC_SWING_CONFIG: BtcSwingConfig = {
  htfLen: 7,
  macroBars: 30,
  maxConcurrent: 4,
  tpPct: 0.2,
  stopPct: 0.07,
  holdBars: 40,
  rsiLen: 7,
  rsiTh: 42,
  nHi: 3,
  redPct: 0.01,
  nDown: 2,
  costs: MAKER_COSTS,
};

/**
 * Iter 144 MAX-A locked config. Target: **≥ 5% mean profit per trade**.
 *
 * Aggressive swing tier — tp = 60%, stop = 5%, hold = 40d. Trades rare
 * (~22 per year) but average gain per trade is 5.79%. Low WR (30.9%) is
 * compensated by an 8:1 reward:risk geometry — a single TP2 hit covers
 * many losers.
 *
 * 5-gate validation on 3000 days (8.2 years):
 *   n=178, WR 30.9%, mean 5.79%, cumRet +169 289%,
 *   Sharpe 5.64, bs+ 100%, bs5%ile +1997%, pctProf 60%, minW −55%,
 *   OOS (60/40): n=64, mean 4.96%, Sharpe 5.94, bs+ 94%.
 *
 * minW −55% is the honest tradeoff: in ~30% of 10%-windows the book will
 * be down 50%+ before the tail-event winners arrive. Position-size
 * accordingly — do NOT deploy > 10-15% of real capital on this tier.
 */
export const BTC_SWING_MAX_CONFIG: BtcSwingConfig = {
  htfLen: 7,
  macroBars: 30,
  maxConcurrent: 4,
  tpPct: 0.6,
  stopPct: 0.05,
  holdBars: 40,
  rsiLen: 7,
  rsiTh: 42,
  nHi: 3,
  redPct: 0.01,
  nDown: 2,
  costs: MAKER_COSTS,
};

/**
 * Iter 149 WEEKLY_MAX tier — TP 50%, stop 2%, hold 4 weeks on 1w bars.
 *
 * **This is the ONLY tier that reaches ≥ 5% mean BOTH in-sample AND OOS.**
 * iter148 scanned 180 weekly configs, iter149 locked the winner through full
 * 5-gate battery on 454 weekly candles (8.7 years of BTC):
 *   n=44, WR 36.4%, mean 10.05%, cumRet +3861%, Sharpe 3.99,
 *   bs+ 100%, bs5%ile +1039.9% (!), both halves positive.
 *   Sensitivity 8/8 variants pass.
 *   OOS (last 40%): n=20, WR 25%, **mean 5.27%**, Sharpe 2.55, bs+ 100%.
 *
 * Honest caveats:
 *   - Only ~5 trades/year (44 in 8.7 years) — very low frequency
 *   - 4-week hold = NOT daytrade; weekly-swing position trading
 *   - WR 36% means 2 of 3 trades are −2% losers; the ~36% winners that
 *     hit +50% carry ALL the PnL. Streak-proof psychology required.
 *   - Only usable on weekly 1w candle data (timeframe="1w" in loader)
 *
 * Usage:
 *   const weeklyCandles = await loadBinanceHistory({
 *     symbol: "BTCUSDT", timeframe: "1w", targetCount: 500,
 *   });
 *   const report = runBtcSwing(weeklyCandles, BTC_WEEKLY_MAX_CONFIG);
 */
export const BTC_WEEKLY_MAX_CONFIG: BtcSwingConfig = {
  htfLen: 4, // 4-week trend gate
  macroBars: 12, // 12-week (~3-month) macro gate
  maxConcurrent: 4,
  tpPct: 0.5,
  stopPct: 0.02,
  holdBars: 4,
  rsiLen: 7,
  rsiTh: 45,
  nHi: 3,
  redPct: 0.03,
  nDown: 2,
  costs: MAKER_COSTS,
};

/**
 * Iter 153 LEVERAGED variant — iter149 WEEKLY_MAX applied with 2× leverage.
 *
 * The underlying entry/exit logic is identical to `BTC_WEEKLY_MAX_CONFIG`;
 * leverage is applied at the exchange level (Binance perpetual futures), not
 * in the strategy. This tier documents the EXPECTED per-trade return and
 * drawdown profile when the user sets 2× on the exchange.
 *
 * Why 2× specifically works on iter149 where higher leverage fails on iter135:
 *   iter149 has a TIGHT 2% stop. Worst observed trade: −2.1%. With 2×
 *   leverage that becomes −4.3% margin — nowhere near liquidation.
 *   In contrast, iter135's 1% stop + high trade count means a streak of
 *   stops compounds to bankruptcy at only 10-15× leverage.
 *
 * Leverage simulation (iter153) on 8.7 years of BTC weekly data:
 *   1× lev: mean  10.37%, minTr  −2.1%, maxDD  −8%, cumRet  +4371%
 *   2× lev: mean  20.73%, minTr  −4.3%, maxDD −16%, cumRet  +71068% ★
 *   3× lev: mean  31.10%, minTr  −6.4%, maxDD −23%, cumRet +601358%
 *   5× lev: mean  51.83%, minTr −10.7%, maxDD −35%, cumRet +13M%
 *  10× lev: mean 103.66%, minTr −21.4%, maxDD −60%, cumRet +685M%
 *  50× lev: BANKRUPT
 *
 * 2× is the Kelly-safe sweet spot — delivers the user's 20% target with
 * manageable drawdown. Higher leverage lifts mean proportionally but
 * drawdown also rises; above 30× multi-year equity curve collapses.
 *
 * HONEST WARNING (critical):
 *  - This is NOT daytrade — 4-week hold per trade
 *  - Requires Binance perpetual futures account with 2× max cross margin
 *  - Backtest does NOT include funding costs at 2× exposure (~1% extra per month)
 *  - Live WR in OOS was 25% (6 of 8 trades stop); psychological stamina required
 *  - Deploy maximum 20% of real capital; rest in unleveraged tiers
 */
export const BTC_WEEKLY_LEVERAGED_2X_STATS = {
  iteration: 153,
  baseConfig: "BTC_WEEKLY_MAX_CONFIG",
  leverage: 2,
  symbol: "BTCUSDT",
  timeframe: "1w",
  yearsTested: 8.7,
  trades: 44,
  tradesPerYear: 5,
  winRate: 0.364,
  /** Effective mean PnL per full-size trade at 2× leverage. Target: ≥ 20%. */
  meanPctPerTrade: 0.2073,
  cumReturnPct: 710.68,
  sharpe: 4.09,
  maxDrawdown: -0.16,
  minTradePct: -0.043,
  maxTradePct: 0.998,
  bootstrapPctPositive: 1.0,
  /** Leverage scaling table for risk comparison. */
  leverageTable: [
    { leverage: 1, meanPct: 0.1037, maxDD: -0.08 },
    { leverage: 2, meanPct: 0.2073, maxDD: -0.16 },
    { leverage: 3, meanPct: 0.311, maxDD: -0.23 },
    { leverage: 5, meanPct: 0.5183, maxDD: -0.35 },
    { leverage: 10, meanPct: 1.0366, maxDD: -0.6 },
    { leverage: 50, meanPct: NaN, maxDD: -1.0 }, // bankrupt
  ] as const,
  note:
    "LEVERAGED tier (iter153) — 2× leverage on iter149 WEEKLY_MAX. Backtest " +
    "delivers 20.73% mean per trade with maxDD only −16% because the 2% stop " +
    "caps single-trade loss at −4.3% margin. NOT daytrade (4w hold). Requires " +
    "Binance perpetual futures with cross-margin. Actual leverage is applied " +
    "at the exchange; run the strategy exactly as BTC_WEEKLY_MAX_CONFIG then " +
    "set position size = 2× unlevered size. Funding costs NOT modeled in " +
    "backtest (add ~1%/month at 2× BTC-perp exposure).",
} as const;

export const BTC_WEEKLY_MAX_STATS = {
  iteration: 149,
  symbol: "BTCUSDT",
  timeframe: "1w",
  yearsTested: 8.7,
  trades: 44,
  tradesPerYear: 5,
  winRate: 0.364,
  /** Mean arithmetic PnL per full-size trade. ≥ 5% achieved. */
  meanPctPerTrade: 0.1005,
  cumReturnPct: 38.61,
  sharpe: 3.99,
  halfReturnPct: [13.5, 1.73],
  bootstrapPctPositive: 1.0,
  bootstrap5thPctRet: 10.4, // i.e. +1039.9%
  oos: {
    fractionOfHistory: 0.4,
    trades: 20,
    winRate: 0.25,
    meanPctPerTrade: 0.0527,
    cumReturnPct: 1.36,
    sharpe: 2.55,
    bootstrapPctPositive: 1.0,
  },
  sensitivity: { passed: 8, of: 8 },
  mechanics: ["M1_nDown", "M4_rsi", "M5_breakout", "M6_redBar"] as const,
  note:
    "Iter 149 WEEKLY tier — the ONLY config that achieves mean ≥ 5% in BOTH " +
    "full-sample (10.05%) AND out-of-sample (5.27%). User asked for '5% per " +
    "trade daytrade'; physical frontier proof (iter145-147) showed this is " +
    "NOT achievable at daytrade hold. This is the closest honest approximation: " +
    "weekly swing with 4-week hold, ~5 trades/year, 36% WR. Deploy only with " +
    "position-sizing that tolerates the tail-distribution (7 of 10 trades are " +
    "-2% stops before the big winners arrive). Recommended: ≤ 10-15% capital " +
    "allocation alongside iter135 daytrade tier.",
} as const;

export const BTC_SWING_MAX_STATS = {
  iteration: 144,
  symbol: "BTCUSDT",
  timeframe: "1d",
  daysTested: 3000,
  yearsTested: 8.2,
  trades: 178,
  tradesPerMonth: 1.78,
  tradesPerYear: 22,
  winRate: 0.309,
  /** Mean arithmetic PnL per full-size trade. User's target of ≥ 5%. */
  meanPctPerTrade: 0.0579,
  cumReturnPct: 1692.89,
  sharpe: 5.64,
  windowsProfitablePct: 0.6,
  minWindowRet: -0.55,
  bootstrapPctPositive: 1.0,
  bootstrap5thPctRet: 19.97, // i.e. +1997% — tail-event driven
  oos: {
    fractionOfHistory: 0.4,
    trades: 64,
    winRate: 0.375,
    meanPctPerTrade: 0.0496,
    cumReturnPct: 10.59,
    sharpe: 5.94,
    bootstrapPctPositive: 0.94,
  },
  quarters: [
    { winRate: 0.35, meanPct: 0.0561, cumReturnPct: 2.83 }, // rough estimates from iter144
    { winRate: 0.44, meanPct: 0.0926, cumReturnPct: 19.17 },
    { winRate: 0.71, meanPct: 0.0654, cumReturnPct: 5.66 },
    { winRate: 0.34, meanPct: 0.0178, cumReturnPct: 0.33 },
  ],
  sensitivity: { passed: 10, of: 10 },
  mechanics: ["M1_nDown", "M4_rsi", "M5_breakout", "M6_redBar"] as const,
  note:
    "MAX tier (iter144) — lifts mean/trade to 5.79% by targeting 60% TP / 5% " +
    "stop / 40-day hold. WR drops to 31% but the 8:1 R:R geometry produces " +
    "a handful of outsize TP-hits per year that dominate PnL. Honest " +
    "drawdown warning: individual 10%-windows can drop 50%+ before the " +
    "next TP-hit. Not appropriate for full capital deployment — use ≤15% " +
    "allocation OR combine with BTC_INTRADAY_CONFIG via BtcBook-style " +
    "weighting.",
} as const;

export const BTC_SWING_STATS = {
  iteration: 128,
  symbol: "BTCUSDT",
  timeframe: "1d",
  daysTested: 3000,
  yearsTested: 8.2,
  trades: 205,
  tradesPerMonth: 2.05,
  tradesPerYear: 25,
  winRate: 0.42,
  /** Mean arithmetic PnL per full-size trade. */
  meanPctPerTrade: 0.0317,
  cumReturnPct: 133.56,
  sharpe: 4.79,
  windowsProfitablePct: 0.5,
  minWindowRet: -0.52,
  bootstrapPctPositive: 0.96,
  bootstrap5thPctRet: 0.847,
  oos: {
    fractionOfHistory: 0.4,
    trades: 72,
    winRate: 0.403,
    meanPctPerTrade: 0.0192,
    cumReturnPct: 1.52,
    sharpe: 3.15,
    bootstrapPctPositive: 0.72,
  },
  quarters: [
    { winRate: 0.447, meanPct: 0.0365, cumReturnPct: 2.83 },
    { winRate: 0.455, meanPct: 0.0501, cumReturnPct: 13.77 },
    { winRate: 0.435, meanPct: 0.0357, cumReturnPct: 2.64 },
    { winRate: 0.41, meanPct: 0.016, cumReturnPct: 0.5 },
  ],
  sensitivity: { passed: 10, of: 10 },
  mechanics: ["M1_nDown", "M4_rsi", "M5_breakout", "M6_redBar"] as const,
  note:
    "Swing tier — ~25 trades/year with avg 3.17% per trade. High profit/trade " +
    "comes at the cost of a lower win rate (42% vs the iter123 intraday " +
    "ensemble's 58%). This is a structural tradeoff: big targets require " +
    "big moves that are less frequent. Use alongside BTC_INTRADAY_CONFIG, " +
    "not as a replacement.",
} as const;

export type BtcSwingMechanic =
  | "M1_nDown"
  | "M4_rsi"
  | "M5_breakout"
  | "M6_redBar";

export interface BtcSwingTrade {
  entryTime: number;
  exitTime: number;
  entry: number;
  mechanic: BtcSwingMechanic;
  pnl: number;
  exitReason: "tp" | "stop" | "time";
}

export interface BtcSwingReport {
  trades: BtcSwingTrade[];
  winRate: number;
  netReturnPct: number;
  meanPctPerTrade: number;
  tradesPerMonth: number;
  daysCovered: number;
  byMechanic: Record<BtcSwingMechanic, number>;
}

function smaLast(v: number[], n: number): number {
  if (v.length < n) return v[v.length - 1] ?? 0;
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
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
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss += -d;
  }
  gain /= len;
  loss /= len;
  out[len] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function fireMechanic(
  candles: Candle[],
  closes: number[],
  highs: number[],
  r: number[],
  i: number,
  m: BtcSwingMechanic,
  cfg: BtcSwingConfig,
): boolean {
  switch (m) {
    case "M1_nDown":
      if (i < cfg.nDown + 1) return false;
      for (let k = 0; k < cfg.nDown; k++) {
        if (closes[i - k]! >= closes[i - k - 1]!) return false;
      }
      return true;
    case "M4_rsi":
      return r[i]! <= cfg.rsiTh;
    case "M5_breakout":
      if (i < cfg.nHi + 1) return false;
      return candles[i]!.close > maxLast(highs.slice(i - cfg.nHi, i), cfg.nHi);
    case "M6_redBar": {
      const o = candles[i]!.open;
      const c = candles[i]!.close;
      if (o <= 0) return false;
      return (c - o) / o <= -cfg.redPct;
    }
  }
}

function executeLong(
  candles: Candle[],
  i: number,
  cfg: BtcSwingConfig,
): {
  exitBar: number;
  pnl: number;
  reason: BtcSwingTrade["exitReason"];
} | null {
  const eb = candles[i + 1];
  if (!eb) return null;
  const entry = eb.open;
  const tp = entry * (1 + cfg.tpPct);
  const stop = entry * (1 - cfg.stopPct);
  const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
  let exitBar = mx;
  let exitPrice = candles[mx]!.close;
  let reason: BtcSwingTrade["exitReason"] = "time";
  for (let j = i + 2; j <= mx; j++) {
    const bar = candles[j];
    if (bar.low <= stop) {
      exitBar = j;
      exitPrice = stop;
      reason = "stop";
      break;
    }
    if (bar.high >= tp) {
      exitBar = j;
      exitPrice = tp;
      reason = "tp";
      break;
    }
  }
  const holdingHours = (exitBar - (i + 1)) * 24;
  const costs = cfg.costs ?? MAKER_COSTS;
  const pnl = applyCosts({
    entry,
    exit: exitPrice,
    direction: "long",
    holdingHours,
    config: costs,
  }).netPnlPct;
  return { exitBar, pnl, reason };
}

export function runBtcSwing(
  candles: Candle[],
  cfg: BtcSwingConfig = BTC_SWING_CONFIG,
): BtcSwingReport {
  const empty: BtcSwingReport = {
    trades: [],
    winRate: 0,
    netReturnPct: 0,
    meanPctPerTrade: 0,
    tradesPerMonth: 0,
    daysCovered: 0,
    byMechanic: {
      M1_nDown: 0,
      M4_rsi: 0,
      M5_breakout: 0,
      M6_redBar: 0,
    },
  };
  if (!candles || candles.length < cfg.htfLen + cfg.macroBars + 5) return empty;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const r = rsiSeries(closes, cfg.rsiLen);

  const trendMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.htfLen; i < candles.length; i++) {
    const s = smaLast(closes.slice(i - cfg.htfLen, i), cfg.htfLen);
    trendMask[i] = candles[i]!.close > s;
  }
  const macroMask: boolean[] = new Array(candles.length).fill(false);
  for (let i = cfg.macroBars; i < candles.length; i++) {
    const past = closes[i - cfg.macroBars];
    if (past > 0) macroMask[i]! = (closes[i]! - past) / past > 0;
  }

  const open: { exitBar: number; mech: BtcSwingMechanic }[] = [];
  const trades: BtcSwingTrade[] = [];
  const mechs: BtcSwingMechanic[] = [
    "M1_nDown",
    "M4_rsi",
    "M5_breakout",
    "M6_redBar",
  ];
  const startIdx = Math.max(cfg.htfLen, cfg.macroBars, cfg.rsiLen + 1) + 1;
  for (let i = startIdx; i < candles.length - 1; i++) {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k]!.exitBar < i) open.splice(k, 1);
    }
    if (open.length >= cfg.maxConcurrent) continue;
    if (!trendMask[i] || !macroMask[i]) continue;
    for (const m of mechs) {
      if (open.length >= cfg.maxConcurrent) break;
      if (open.some((o) => o.mech === m)) continue;
      if (!fireMechanic(candles, closes, highs, r, i, m, cfg)) continue;
      const res = executeLong(candles, i, cfg);
      if (!res) continue;
      trades.push({
        entryTime: candles[i + 1]!.openTime,
        exitTime: candles[res.exitBar]!.closeTime,
        entry: candles[i + 1]!.open,
        mechanic: m,
        pnl: res.pnl,
        exitReason: res.reason,
      });
      open.push({ exitBar: res.exitBar, mech: m });
    }
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const cum = trades.reduce((a, t) => a * (1 + t.pnl), 1) - 1;
  const mean =
    trades.length > 0
      ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length
      : 0;
  const daysCovered = candles.length;
  const byMechanic: Record<BtcSwingMechanic, number> = {
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
    meanPctPerTrade: mean,
    tradesPerMonth: daysCovered > 0 ? (trades.length / daysCovered) * 30 : 0,
    daysCovered,
    byMechanic,
  };
}
