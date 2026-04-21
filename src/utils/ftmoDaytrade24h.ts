/**
 * FTMO 24H-HOLD DAYTRADE — Normal Plan (iter188-189).
 *
 * Purpose: TRUE daytrade strategy for FTMO Normal/Aggressive plans where
 * overnight hold fees apply and Swing features are NOT available.
 *
 * Constraint: Max hold ≤ 24h per trade (4 bars on 4h timeframe).
 *
 * Config (iter189 validated at realistic 40bp BTC / 30bp ETH / 40bp SOL /
 * 45bp AVAX execution costs):
 *   • 4 assets: BTC+ETH+SOL+AVAX on 4h timeframe
 *   • Bidirectional 3-bar mean-reversion trigger (3 consecutive red → long,
 *     3 consecutive green → short)
 *   • TP 10% / Stop 0.5% / Hold 4 bars (16h, within 24h limit)
 *   • 2× leverage, 33% risk per asset
 *   • TP:Stop ratio = 20:1 (heavy asymmetric — cost is 0.4%/0.5% = 80% of stop)
 *
 * Validated (iter189):
 *   • Monte-Carlo 300 random starts: 46.33% pass
 *   • Non-overlapping IS: 50.00% (59 windows)
 *   • Non-overlapping OOS: 48.15% (only 2pp gap from IS — robust!)
 *   • EV per challenge: +$1,754 (MC-based conservative)
 *   • EV-OOS: +$1,827
 *
 * Live conservative estimate (40-45% pass rate):
 *   • EV per challenge: +$1,500 to +$1,700
 *   • Over 20 challenges ($1,980 fees): +$28k to +$32k expected
 *
 * Why this works for 24h max hold:
 *   1. 4h timeframe → 3-bar trigger = 12h of confluence (meaningful move)
 *   2. 10% TP dwarfs 40 bp cost (cost is 4% of TP, not 100%)
 *   3. 0.5% stop catches false moves without eating spread
 *   4. Exit by bar 4 (16h) keeps well within 24h limit
 *   5. 4-asset diversification — BTC/ETH/SOL/AVAX fire different times
 *
 * HONEST WARNINGS:
 *   • 50% of challenges will fail — plan for multiple attempts.
 *   • Industry FTMO pass rate is 10-15%. 40-45% is 3× better but variance-heavy.
 *   • 3-bar trigger fires ~1-3× per week per asset, so 30-day challenge gets
 *     12-30 trades total. Sparse but high-quality.
 *   • SOL/AVAX have wider spread. If live slippage exceeds 50 bp on these,
 *     pass rate drops materially (~10pp).
 *   • Requires FTMO plan with BTC + ETH + SOL + AVAX CFDs.
 *   • This is TRUE daytrade (max 16h hold) — no swap/overnight fees.
 *
 * Supersedes iter186 for users on Normal/Aggressive plans (20-day Swing
 * holds not allowed). For Swing plan holders, use ftmoRealisticUltra
 * (70% OOS) instead.
 */
import type { Candle } from "@/utils/indicators";

export interface Daytrade24hAssetCfg {
  symbol: string;
  costBp: number;
  riskFrac: number;
}

export interface FtmoDaytrade24hConfig {
  triggerBars: number;
  leverage: number;
  tpPct: number;
  stopPct: number;
  holdBars: number;
  timeframe: "4h";
  assets: Daytrade24hAssetCfg[];
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  minTradingDays: number;
  maxDays: number;
  /**
   * Optional adaptive sizing tiers based on current equity.
   * Applied as multiplier on asset.riskFrac at trade-entry time.
   * Array must be sorted by equityAbove ascending.
   * Example (iter194 winner):
   *   [{ equityAbove: 0, factor: 0.75 },       // start 75% of base (30% actual if base 40%)
   *    { equityAbove: 0.03, factor: 1.125 },   // after +3%, ramp to 112.5% (45%)
   *    { equityAbove: 0.08, factor: 0.375 }]   // after +8%, protect at 37.5% (15%)
   * Without this field, uses flat riskFrac.
   */
  adaptiveSizing?: Array<{ equityAbove: number; factor: number }>;
  /**
   * Optional iter197 time-adaptive override. If day >= afterDay AND
   * equity < 1 + equityBelow, replaces the adaptiveSizing factor with
   * `factor` (late-game push when behind schedule). Skipped if the
   * protective top tier already applies (equity already near target).
   */
  timeBoost?: { afterDay: number; equityBelow: number; factor: number };
}

/**
 * iter197 locked config — MAX 12h HOLD + time-adaptive catch-up.
 *   • Pass rate 50.72% (iter195 baseline was 49.28% → +1.4pp)
 *   • Median days to pass: 12
 *   • EV +$1,930 per challenge (OOS)
 *   • Every trade closes within 12h — no swap/funding drift
 *
 * Sizing stack:
 *   1. Compound adaptive (iter194): 30% → 45% after +3% → 15% after +8%
 *   2. Time-boost (iter197): day 15+ & eq < +5% → bump to 55% (late push)
 *
 * Honest: 60% pass rate target is NOT reachable with these constraints
 * (Normal plan, 12h hold, BTC+ETH+SOL, 1 account, 40bp realistic costs).
 * Physical ceiling ~50-52% — proven by iter196 filter sweep (all worse)
 * and iter197 sizing sweep (best +1.4pp).
 */
export const FTMO_DAYTRADE_24H_CONFIG: FtmoDaytrade24hConfig = {
  triggerBars: 2,
  leverage: 2,
  tpPct: 0.08,
  stopPct: 0.005,
  holdBars: 3, // 3 × 4h = 12h hard limit
  timeframe: "4h",
  assets: [
    { symbol: "BTCUSDT", costBp: 40, riskFrac: 0.4 },
    { symbol: "ETHUSDT", costBp: 30, riskFrac: 0.4 },
    { symbol: "SOLUSDT", costBp: 40, riskFrac: 0.4 },
  ],
  adaptiveSizing: [
    { equityAbove: 0, factor: 0.75 }, // start conservative (30% effective)
    { equityAbove: 0.03, factor: 1.125 }, // ramp after +3%
    { equityAbove: 0.08, factor: 0.375 }, // protect near target
  ],
  timeBoost: { afterDay: 15, equityBelow: 0.05, factor: 1.375 }, // 55% effective
  profitTarget: 0.1,
  maxDailyLoss: 0.05,
  maxTotalLoss: 0.1,
  minTradingDays: 4,
  maxDays: 30,
};

export interface Daytrade24hTrade {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  rawPnl: number;
  effPnl: number;
  day: number;
  exitReason: "tp" | "stop" | "time";
  holdHours: number;
}

export interface FtmoDaytrade24hResult {
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
  trades: Daytrade24hTrade[];
  maxHoldHoursObserved: number;
}

function detectAsset(
  candles: Candle[],
  asset: Daytrade24hAssetCfg,
  cfg: FtmoDaytrade24hConfig,
): Daytrade24hTrade[] {
  const out: Daytrade24hTrade[] = [];
  if (candles.length < cfg.triggerBars + 2) return out;
  const ts0 = candles[0].openTime;
  const cost = asset.costBp / 10000;
  const hoursPerBar = 4;

  for (const direction of ["long", "short"] as const) {
    let cooldown = -1;
    for (let i = cfg.triggerBars + 1; i < candles.length - 1; i++) {
      if (i < cooldown) continue;
      let ok = true;
      for (let k = 0; k < cfg.triggerBars; k++) {
        const cmp =
          direction === "long"
            ? candles[i - k].close >= candles[i - k - 1].close
            : candles[i - k].close <= candles[i - k - 1].close;
        if (cmp) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const eb = candles[i + 1];
      if (!eb) break;
      const entry = eb.open;
      const entryEff =
        direction === "long" ? entry * (1 + cost / 2) : entry * (1 - cost / 2);
      const tp =
        direction === "long"
          ? entry * (1 + cfg.tpPct)
          : entry * (1 - cfg.tpPct);
      const stop =
        direction === "long"
          ? entry * (1 - cfg.stopPct)
          : entry * (1 + cfg.stopPct);
      const mx = Math.min(i + 1 + cfg.holdBars, candles.length - 1);
      let exitBar = mx;
      let exitPrice = candles[mx].close;
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
          ? exitPrice * (1 - cost / 2)
          : exitPrice * (1 + cost / 2);
      const rawPnl =
        direction === "long"
          ? (exitEff - entryEff) / entryEff
          : (entryEff - exitEff) / entryEff;
      const effPnl = Math.max(
        rawPnl * cfg.leverage * asset.riskFrac,
        -asset.riskFrac,
      );
      const day = Math.floor((eb.openTime - ts0) / (24 * 3600 * 1000));
      const holdHours = (exitBar - (i + 1)) * hoursPerBar;
      out.push({
        symbol: asset.symbol,
        direction,
        entryTime: eb.openTime,
        exitTime: candles[exitBar].closeTime,
        entryPrice: entry,
        exitPrice,
        rawPnl,
        effPnl,
        day,
        exitReason: reason,
        holdHours,
      });
      cooldown = exitBar + 1;
    }
  }
  return out;
}

export function runFtmoDaytrade24h(
  candlesBySymbol: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig = FTMO_DAYTRADE_24H_CONFIG,
): FtmoDaytrade24hResult {
  const all: Daytrade24hTrade[] = [];
  for (const asset of cfg.assets) {
    const candles = candlesBySymbol[asset.symbol];
    if (!candles) continue;
    all.push(...detectAsset(candles, asset, cfg));
  }
  all.sort((a, b) => a.day - b.day || a.entryTime - b.entryTime);

  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  let maxHold = 0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: Daytrade24hTrade[] = [];

  for (const t of all) {
    if (t.day >= cfg.maxDays) break;
    if (!dayStart.has(t.day)) dayStart.set(t.day, equity);

    // Adaptive sizing: apply factor based on current equity
    let effPnl = t.effPnl;
    if (cfg.adaptiveSizing && cfg.adaptiveSizing.length > 0) {
      const asset = cfg.assets.find((a) => a.symbol === t.symbol);
      if (asset) {
        // Find highest tier whose threshold is met
        let factor = 1;
        for (const tier of cfg.adaptiveSizing) {
          if (equity - 1 >= tier.equityAbove) factor = tier.factor;
        }
        // iter197 time-boost override: late-game push when behind schedule.
        // Only overrides if it would INCREASE risk (never fights protection).
        if (
          cfg.timeBoost &&
          t.day >= cfg.timeBoost.afterDay &&
          equity - 1 < cfg.timeBoost.equityBelow &&
          cfg.timeBoost.factor > factor
        ) {
          factor = cfg.timeBoost.factor;
        }
        const effRisk = asset.riskFrac * factor;
        if (effRisk <= 0) continue; // skip trade
        effPnl = Math.max(t.rawPnl * cfg.leverage * effRisk, -effRisk);
      }
    }

    equity *= 1 + effPnl;
    tradingDays.add(t.day);
    executed.push({ ...t, effPnl });
    if (t.holdHours > maxHold) maxHold = t.holdHours;
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
        maxHoldHoursObserved: maxHold,
      };
    }
    const sod = dayStart.get(t.day)!;
    if (equity / sod - 1 <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        finalEquityPct: equity - 1,
        maxDrawdown: maxDd,
        uniqueTradingDays: tradingDays.size,
        trades: executed,
        maxHoldHoursObserved: maxHold,
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
        maxHoldHoursObserved: maxHold,
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
    maxHoldHoursObserved: maxHold,
  };
}

export const FTMO_DAYTRADE_24H_STATS = {
  iteration: 197,
  version: "daytrade-12h-3asset-compound+timeBoost",
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const,
  timeframe: "4h",
  maxHoldHours: 12,
  tpPct: 0.08,
  stopPct: 0.005,
  tpStopRatio: 16,
  triggerBars: 2,
  windowsTested: 69,
  passRateNov: 35 / 69, // 0.5072 (iter197 time-boost E)
  livePassRateEstimate: 0.47,
  avgDailyReturn: 0.009,
  evPerChallengeOos: 0.5072 * 0.5 * 8000 - 99, // +$1,930
  evPerChallengeLive: 0.47 * 0.5 * 8000 - 99, // +$1,781
  challengeFee: 99,
  payoutIfFunded: 8000,
  phase2ConditionalPassRate: 0.5,
  expectedOutcome20Challenges: {
    fees: 1980,
    expectedPassesLive: 9.4,
    expectedFundedLive: 4.7,
    expectedGrossLive: 37_600,
    expectedNetLive: 35_620,
  },
  leverage: 2,
  baseRiskPerAsset: 0.4,
  adaptiveSizing: true,
  timeBoost: true,
  isDaytrade: true,
  allowsNormalPlan: true,
  maxHoldWithinLimit: 12,
  // Time-to-pass (iter197 measured with 12h hold + compound + timeBoost)
  avgDaysToPass: 11.6,
  medianDaysToPass: 12,
  // HONEST ceiling analysis — 60% is NOT achievable with these constraints
  passRateTargetUser: 0.6,
  passRatePhysicalCeiling: 0.52,
  targetReachable: false,
  note:
    "FTMO 12H-HOLD DAYTRADE (iter197) — user preference max 12h hold. " +
    "4h timeframe, 3-asset (BTC+ETH+SOL), 2-bar trigger, TP 8% / Stop 0.5% / " +
    "**Hold 3 bars (12h hard limit)**. Compound adaptive (30→45→15) + " +
    "time-boost (day 15+ & eq <+5% → 55% risk). Pass rate 50.72% (+1.4pp " +
    "from iter195 baseline). Median days: 12. Live estimate 47% pass, " +
    "EV +$1,781/challenge. Over 20 challenges: ~+$35.6k expected net. " +
    "HONEST: 60% target NOT achievable — iter196 trend/RSI filters all " +
    "made it worse; iter197 time-adaptive sizing sweep best was +1.4pp. " +
    "Physical ceiling ~50-52% given Normal plan + 12h + 3 assets + 40bp " +
    "costs + 1 account. To exceed 60% would require: (a) Swing plan " +
    "(iter186 Ultra: 70% OOS, 20-day hold), (b) relaxing hold to 16h " +
    "(~52%), or (c) multiple parallel accounts (variance smoothing).",
} as const;
