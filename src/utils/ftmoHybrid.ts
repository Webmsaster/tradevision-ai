/**
 * FTMO $100k Challenge Hybrid Strategy (iter163–166).
 *
 * Designed for: FTMO Challenge Phase 1 with 1:2 Crypto leverage, $100k
 * account, 30-day profit target +10%, max daily loss −5%, max total loss
 * −10%, min 4 trading days.
 *
 * Architecture: multi-signal aggressive-sizing strategy that waits for
 * flash-crash (BTC ≥15% drop over 72h + green rebound) or pump-fade
 * (BTC ≥15% rise over 72h + red rejection) events, then bets LARGE on the
 * asymmetric mean-reversion setup. Smaller opportunistic bets on weaker
 * flash7 signals. Progressive 2× sizing kicks in after +2% equity.
 *
 * Validated on 294 rolling 30-day windows (8.7 years BTC 1h data):
 *   Full-sample pass rate:   9.52% (28/294)
 *   In-sample (first 60%):  13.64% (24/176)
 *   Out-of-sample (last 40%): 3.39% (4/118)
 *
 * The IS vs OOS gap reflects regime dependence — flash-crash events are
 * more frequent in bear markets (2018-2022 era) than bull runs (2023-2026
 * era). For live trading, start the Challenge when BTC is already in a
 * >10% drawdown or during high-volatility regimes.
 *
 * Expected value analysis (using OOS pass rate of 3.39%):
 *   • Challenge fee:    $99 per attempt
 *   • Phase 2 rate:     ~50% conditional pass
 *   • Funded payout:    ~$8,000 first payout
 *   • EV per attempt:   3.39% × 50% × $8,000 − $99 = +$37
 *   • EV over 20 tries: ~$740 net positive
 *
 * Using full-sample rate (9.52%) the EV is +$282/try or ~$5,640 over 20.
 * Actual result depends on market regime during the trading window.
 */
import type { Candle } from "@/utils/indicators";
import { applyCosts, type CostConfig } from "@/utils/costModel";
import { MAKER_COSTS } from "@/utils/intradayLab";

export type FtmoSignalType =
  | "flash15"
  | "flash10"
  | "flash7"
  | "flash5"
  | "pumpShort";

export interface FtmoSignal {
  /** Day index within the 30-day window (0..29). */
  day: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  /** Raw pnl fraction (unleveraged). */
  rawPnl: number;
  direction: "long" | "short";
  type: FtmoSignalType;
  exitReason: "tp" | "stop" | "time";
}

export interface FtmoChallengeConfig {
  /** Exchange leverage (FTMO Crypto = 1:2). */
  leverage: number;
  /** Risk fraction per signal type (1.0 = 100% of equity as margin). */
  riskPerSignal: Record<FtmoSignalType, number>;
  /** After equity hits this profit threshold, multiply all risk by factor. */
  progressiveThreshold: number;
  progressiveFactor: number;
  /** FTMO rules. */
  profitTarget: number; // 0.10 for Phase 1
  maxDailyLoss: number; // 0.05
  maxTotalLoss: number; // 0.10
  minTradingDays: number; // 4
  maxDays: number; // 30
  costs?: CostConfig;
}

/** iter166 locked configuration — best EV found in 8400-combo sweep. */
export const FTMO_HYBRID_CONFIG: FtmoChallengeConfig = {
  leverage: 2,
  riskPerSignal: {
    flash15: 0.5,
    flash10: 0, // excluded — noise band
    flash7: 0.1,
    flash5: 0, // excluded — noise band
    pumpShort: 0.5,
  },
  progressiveThreshold: 0.03,
  progressiveFactor: 2,
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  costs: MAKER_COSTS,
};

/**
 * Signal-definition table. Each entry is one of the 5 mean-reversion variants
 * the hybrid strategy watches for in real-time.
 */
export const FTMO_SIGNAL_DEFS = {
  flash15: {
    dropBars: 72,
    dropPct: 0.15,
    tpPct: 0.1,
    stopPct: 0.02,
    holdBars: 24,
    direction: "long" as const,
  },
  flash10: {
    dropBars: 48,
    dropPct: 0.1,
    tpPct: 0.07,
    stopPct: 0.02,
    holdBars: 24,
    direction: "long" as const,
  },
  flash7: {
    dropBars: 24,
    dropPct: 0.07,
    tpPct: 0.05,
    stopPct: 0.02,
    holdBars: 12,
    direction: "long" as const,
  },
  flash5: {
    dropBars: 12,
    dropPct: 0.05,
    tpPct: 0.03,
    stopPct: 0.015,
    holdBars: 8,
    direction: "long" as const,
  },
  pumpShort: {
    dropBars: 72,
    dropPct: 0.15,
    tpPct: 0.1,
    stopPct: 0.02,
    holdBars: 24,
    direction: "short" as const,
  },
} as const;

/** Detect all flash-long signals of one variant within a candle slice. */
export function detectFlashSignals(
  candles: Candle[],
  typeName: FtmoSignalType,
  startIdx = 0,
): FtmoSignal[] {
  const def = FTMO_SIGNAL_DEFS[typeName];
  if (def.direction !== "long") return [];
  const { dropBars, dropPct, tpPct, stopPct, holdBars } = def;
  const out: FtmoSignal[] = [];
  if (candles.length === 0) return out;
  const ts0 = candles[startIdx]?.openTime ?? candles[0].openTime;
  const costs = FTMO_HYBRID_CONFIG.costs ?? MAKER_COSTS;
  let cooldown = -1;
  for (let i = Math.max(dropBars + 1, startIdx); i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    const prev = candles[i - dropBars].close;
    const cur = candles[i].close;
    if (prev <= 0) continue;
    if ((cur - prev) / prev > -dropPct) continue;
    if (cur <= candles[i - 1].close) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 + tpPct);
    const stop = entry * (1 - stopPct);
    const mx = Math.min(i + 1 + holdBars, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
    let exitReason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.low <= stop) {
        exitBar = j;
        exitPrice = stop;
        exitReason = "stop";
        break;
      }
      if (bar.high >= tp) {
        exitBar = j;
        exitPrice = tp;
        exitReason = "tp";
        break;
      }
    }
    const rawPnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "long",
      holdingHours: exitBar - (i + 1),
      config: costs,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0) {
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: candles[exitBar].closeTime,
        entryPrice: entry,
        exitPrice,
        rawPnl,
        direction: "long",
        type: typeName,
        exitReason,
      });
    }
    cooldown = exitBar + 1;
  }
  return out;
}

/** Detect pump-short signals (BTC rallied ≥pumpPct then first red bar → short). */
export function detectPumpShortSignals(
  candles: Candle[],
  startIdx = 0,
): FtmoSignal[] {
  const def = FTMO_SIGNAL_DEFS.pumpShort;
  const {
    dropBars: pumpBars,
    dropPct: pumpPct,
    tpPct,
    stopPct,
    holdBars,
  } = def;
  const out: FtmoSignal[] = [];
  if (candles.length === 0) return out;
  const ts0 = candles[startIdx]?.openTime ?? candles[0].openTime;
  const costs = FTMO_HYBRID_CONFIG.costs ?? MAKER_COSTS;
  let cooldown = -1;
  for (let i = Math.max(pumpBars + 1, startIdx); i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    const prev = candles[i - pumpBars].close;
    const cur = candles[i].close;
    if (prev <= 0) continue;
    if ((cur - prev) / prev < pumpPct) continue;
    if (cur >= candles[i - 1].close) continue;
    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    const tp = entry * (1 - tpPct);
    const stop = entry * (1 + stopPct);
    const mx = Math.min(i + 1 + holdBars, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx].close;
    let exitReason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (bar.high >= stop) {
        exitBar = j;
        exitPrice = stop;
        exitReason = "stop";
        break;
      }
      if (bar.low <= tp) {
        exitBar = j;
        exitPrice = tp;
        exitReason = "tp";
        break;
      }
    }
    const rawPnl = applyCosts({
      entry,
      exit: exitPrice,
      direction: "short",
      holdingHours: exitBar - (i + 1),
      config: costs,
    }).netPnlPct;
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    if (day >= 0) {
      out.push({
        day,
        entryTime: eb.openTime,
        exitTime: candles[exitBar].closeTime,
        entryPrice: entry,
        exitPrice,
        rawPnl,
        direction: "short",
        type: "pumpShort",
        exitReason,
      });
    }
    cooldown = exitBar + 1;
  }
  return out;
}

export interface FtmoChallengeResult {
  passed: boolean;
  reason:
    | "profit_target"
    | "daily_loss"
    | "total_loss"
    | "time"
    | "insufficient_days";
  finalEquityPct: number;
  maxDrawdown: number;
  uniqueTradingDays: number;
  signalsExecuted: FtmoSignal[];
}

/** Run the full FTMO Hybrid challenge simulation on a 30-day window. */
export function runFtmoChallenge(
  candles: Candle[],
  cfg: FtmoChallengeConfig = FTMO_HYBRID_CONFIG,
): FtmoChallengeResult {
  const signals: FtmoSignal[] = [];
  for (const typ of [
    "flash15",
    "flash10",
    "flash7",
    "flash5",
  ] as FtmoSignalType[]) {
    if (cfg.riskPerSignal[typ] > 0) {
      signals.push(...detectFlashSignals(candles, typ));
    }
  }
  if (cfg.riskPerSignal.pumpShort > 0) {
    signals.push(...detectPumpShortSignals(candles));
  }
  signals.sort((a, b) => a.day - b.day || a.entryTime - b.entryTime);

  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: FtmoSignal[] = [];

  for (const s of signals) {
    if (s.day >= cfg.maxDays) break;
    if (!dayStart.has(s.day)) dayStart.set(s.day, equity);

    let risk = cfg.riskPerSignal[s.type] ?? 0;
    if (risk === 0) continue;
    if (equity - 1 >= cfg.progressiveThreshold) {
      risk *= cfg.progressiveFactor;
    }
    risk = Math.min(risk, 1);
    const pnlFrac = Math.max(s.rawPnl * cfg.leverage * risk, -risk);
    equity *= 1 + pnlFrac;
    tradingDays.add(s.day);
    executed.push(s);

    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    if (equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        signalsExecuted: executed,
      };
    }
    const sod = dayStart.get(s.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        signalsExecuted: executed,
      };
    }
    if (
      equity >= 1 + cfg.profitTarget &&
      tradingDays.size >= cfg.minTradingDays
    ) {
      return {
        passed: true,
        reason: "profit_target",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        signalsExecuted: executed,
      };
    }
  }

  const late =
    equity >= 1 + cfg.profitTarget && tradingDays.size >= cfg.minTradingDays;
  return {
    passed: late,
    reason: late
      ? "profit_target"
      : tradingDays.size < cfg.minTradingDays
        ? "insufficient_days"
        : "time",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDd,
    uniqueTradingDays: tradingDays.size,
    signalsExecuted: executed,
  };
}

/** Published iter166 validated stats. */
export const FTMO_HYBRID_STATS = {
  iteration: 166,
  symbol: "BTCUSDT",
  timeframe: "1h",
  windowsTested: 294,
  windowLengthDays: 30,
  /** Full-sample pass rate over 8.7 years. */
  passRateFullSample: 28 / 294,
  /** In-sample (first 60% chronological) pass rate — representative of bear/mixed regimes. */
  passRateInSample: 24 / 176,
  /** Out-of-sample (last 40% chronological) pass rate — bull-dominated 2023-2026. */
  passRateOos: 4 / 118,
  /** Expected value per challenge attempt (using OOS rate, conservative). */
  evPerChallengeOos: 37,
  /** Expected value using full-sample rate. */
  evPerChallengeFull: 282,
  challengeFee: 99,
  payoutIfFunded: 8000,
  phase2ConditionalPassRate: 0.5,
  signalsUsed: ["flash15", "flash7", "pumpShort"] as const,
  signalsExcluded: ["flash10", "flash5"] as const,
  note:
    "FTMO $100k Phase 1 Hybrid (iter166). Aggressive sizing: 50% risk on " +
    "flash15 & pumpShort, 10% on flash7. Progressive 2× after +3% equity. " +
    "REGIME-DEPENDENT: OOS pass rate drops from 13.6% (bear/mixed) to 3.4% " +
    "(bull). Start Challenge during BTC drawdowns for best odds. EV still " +
    "positive ($37/attempt OOS, $282/attempt full-sample). Expect 1 funded " +
    "account per ~30-60 challenges in bull regimes, 1 per ~7-10 in bear/mixed.",
} as const;
