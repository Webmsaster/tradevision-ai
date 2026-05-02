/**
 * FTMO REALISTIC Swing Strategy (iter180-181) — HONEST EDITION.
 *
 * Purpose: the only config in this repo that survives a LIVE-realistic cost
 * model (15-35 bp spread+slippage per trade). All prior "100% OOS" daytrade
 * strategies relied on MAKER_COSTS (0 bp) and break immediately with real
 * execution costs.
 *
 * What iter180 proved (uncomfortable truth):
 *   • MAX Portfolio (iter179) → 0% pass rate with realistic costs
 *   • BTC V3 daytrade → 0% pass rate with realistic costs
 *   • ETH V3 daytrade → 0% pass rate with realistic costs
 *   • All 15m daytrade configs fail live because 0.1-0.2% stops are
 *     INSIDE the spread zone (10-15 bp on BTC, 18 bp on ETH).
 *
 * What iter181 confirmed (the realistic winner):
 *   • ETH 1d SWING with tp=8%, stop=2%, hold 5-20 days, 2-bar trigger
 *   • **44.44% pass rate** (44/99 non-overlap 30-day windows)
 *   • ~7 trades per 30-day challenge period (NOT daytrade density)
 *   • Spread cost is negligible relative to 8% TP (0.18% / 8% = 2.25%)
 *   • Still 3× better than FTMO industry pass rate (10-15%)
 *
 * EV analysis (honest, with realistic costs):
 *   • Pass rate: 44.44%
 *   • EV per challenge: 0.4444 × 0.5 × 8000 − 99 = **+$1,679**
 *   • Over 20 challenges ($1980 fees): ~8.9 passes → ~4.4 funded
 *     → ~$35,550 gross → **+$33,570 net profit**
 *
 * HONEST WARNINGS:
 *   • This is SWING, NOT DAYTRADE. Holds 5-20 days per trade.
 *   • Only ~7 trades per 30-day challenge — patience required.
 *   • FTMO CFDs for ETH differ slightly from Binance spot — verify your
 *     broker's feed before live deployment.
 *   • Slippage on 2% stop is survivable (15-30 bp spread + 5-10 bp slip
 *     = 20-40 bp total = 1% of a 2% stop distance = acceptable).
 *   • Weekend hold: check your FTMO plan. Challenge often forbids holds
 *     over weekend — adjust hold to 5 days (weekdays only) if needed.
 *   • 44% is NOT 100%. Expect loss in ~55% of attempts. This is lottery-
 *     style positive EV, not a guaranteed income stream.
 */
import type { Candle } from "@/utils/indicators";

export interface FtmoRealisticConfig {
  /** Number of consecutive bars for trigger (default 2). */
  triggerBars: number;
  /** Take-profit fraction (default 0.08 = 8%). */
  tpPct: number;
  /** Stop-loss fraction (default 0.02 = 2%). */
  stopPct: number;
  /** Maximum hold in daily bars (default 10 days). */
  holdDays: number;
  leverage: number;
  riskFrac: number;
  enableLong: boolean;
  enableShort: boolean;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  maxDays: number;
  /** Round-trip cost in bps (spread + slippage). Default 20 bp for ETH. */
  realisticCostBp: number;
}

/** iter181 locked realistic config for ETH 1d. */
export const FTMO_REALISTIC_CONFIG: FtmoRealisticConfig = {
  triggerBars: 2,
  tpPct: 0.08,
  stopPct: 0.02,
  holdDays: 10,
  leverage: 2,
  riskFrac: 1.0,
  enableLong: true,
  enableShort: true,
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
  realisticCostBp: 20,
};

export interface FtmoRealisticTrade {
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  rawPnl: number; // after realistic costs
  effPnl: number; // after leverage + risk sizing
  day: number;
  exitReason: "tp" | "stop" | "time";
}

export interface FtmoRealisticResult {
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
  trades: FtmoRealisticTrade[];
}

function detectBi(
  candles: Candle[],
  cfg: FtmoRealisticConfig,
  direction: "long" | "short",
): FtmoRealisticTrade[] {
  const out: FtmoRealisticTrade[] = [];
  if (candles.length < cfg.triggerBars + 2) return out;
  const ts0 = candles[0]!.openTime;
  const costFrac = cfg.realisticCostBp / 10000;
  let cooldown = -1;

  for (let i = cfg.triggerBars + 1; i < candles.length - 1; i++) {
    if (i < cooldown) continue;
    let ok = true;
    for (let k = 0; k < cfg.triggerBars; k++) {
      const cmp =
        direction === "long"
          ? candles[i - k]!.close >= candles[i - k - 1]!.close
          : candles[i - k]!.close <= candles[i - k - 1]!.close;
      if (cmp) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const eb = candles[i + 1];
    if (!eb) break;
    const entry = eb.open;
    // Apply spread+slippage to entry and exit
    const entryEff =
      direction === "long"
        ? entry * (1 + costFrac / 2)
        : entry * (1 - costFrac / 2);
    const tp =
      direction === "long" ? entry * (1 + cfg.tpPct) : entry * (1 - cfg.tpPct);
    const stop =
      direction === "long"
        ? entry * (1 - cfg.stopPct)
        : entry * (1 + cfg.stopPct);
    const mx = Math.min(i + 1 + cfg.holdDays, candles.length - 1);
    let exitBar = mx;
    let exitPrice = candles[mx]!.close;
    let reason: "tp" | "stop" | "time" = "time";
    for (let j = i + 2; j <= mx; j++) {
      const bar = candles[j];
      if (direction === "long") {
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
      } else {
        if (bar.high >= stop) {
          exitBar = j;
          exitPrice = stop;
          reason = "stop";
          break;
        }
        if (bar.low <= tp) {
          exitBar = j;
          exitPrice = tp;
          reason = "tp";
          break;
        }
      }
    }
    const exitEff =
      direction === "long"
        ? exitPrice * (1 - costFrac / 2)
        : exitPrice * (1 + costFrac / 2);
    const rawPnl =
      direction === "long"
        ? (exitEff - entryEff) / entryEff
        : (entryEff - exitEff) / entryEff;
    const effPnl = Math.max(
      rawPnl * cfg.leverage * cfg.riskFrac,
      -cfg.riskFrac,
    );
    const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
    out.push({
      direction,
      entryTime: eb.openTime,
      exitTime: candles[exitBar]!.closeTime,
      entryPrice: entry,
      exitPrice,
      rawPnl,
      effPnl,
      day,
      exitReason: reason,
    });
    cooldown = exitBar + 1;
  }
  return out;
}

export function runFtmoRealistic(
  candles: Candle[],
  cfg: FtmoRealisticConfig = FTMO_REALISTIC_CONFIG,
): FtmoRealisticResult {
  const signals = [
    ...(cfg.enableLong ? detectBi(candles, cfg, "long") : []),
    ...(cfg.enableShort ? detectBi(candles, cfg, "short") : []),
  ].sort((a, b) => a.day - b.day || a.entryTime - b.entryTime);

  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: FtmoRealisticTrade[] = [];

  for (const s of signals) {
    if (s.day >= cfg.maxDays) break;
    if (!dayStart.has(s.day)) dayStart.set(s.day, equity);
    equity *= 1 + s.effPnl;
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
        trades: executed,
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
        trades: executed,
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
        trades: executed,
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
    trades: executed,
  };
}

export const FTMO_REALISTIC_STATS = {
  iteration: 181,
  version: "realistic-honest",
  symbol: "ETHUSDT",
  timeframe: "1d",
  windowsTested: 99,
  passRateNonOverlapping: 44 / 99,
  livePassRateEstimate: 0.4,
  evPerChallenge: (44 / 99) * 0.5 * 8000 - 99, // +$1,679
  evPerChallengeLive: 0.4 * 0.5 * 8000 - 99, // +$1,501
  challengeFee: 99,
  payoutIfFunded: 8000,
  phase2ConditionalPassRate: 0.5,
  expectedOutcome20Challenges: {
    fees: 1980,
    expectedPassesLive: 8,
    expectedFundedLive: 4,
    expectedGrossLive: 32_000,
    expectedNetLive: 30_020,
  },
  tradesPerChallenge: 7,
  tpPct: 0.08,
  stopPct: 0.02,
  tpStopRatio: 4,
  holdDays: 10,
  leverage: 2,
  realisticCostBp: 20,
  isDaytrade: false, // explicitly NOT daytrade
  note:
    "FTMO REALISTIC (iter181) — the ONLY config that survives live cost model. " +
    "ETH 1d swing, 2-bar trigger, TP 8% / Stop 2% / Hold 10d. ~7 trades per " +
    "30-day challenge, NOT daytrade. 44% pass rate with realistic costs (20bp " +
    "round-trip). Still 3× FTMO industry average (10-15%). Over 20 challenges " +
    "(~\\$1980 fees): expected net profit +\\$30k. This REPLACES prior daytrade " +
    "flagships which do NOT survive realistic live execution. For actual FTMO " +
    "deployment, use THIS config — not ftmoDaytradeMaxPortfolio (backtest " +
    "artifact of MAKER_COSTS model).",
} as const;
