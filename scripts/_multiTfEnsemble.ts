/**
 * Multi-TF ensemble runner.
 *
 * Strategy: pre-compute trades for each (TF, asset) pair on the full history,
 * then for each walk-forward window merge them chronologically and run a
 * single unified equity loop with FTMO rules applied to the combined PnL.
 *
 * Position sizing: each trade keeps its own riskFrac × volMult from detection,
 * but a global `ensembleScale` reduces all positions by 1/N (where N = number
 * of active TFs) to prevent over-leverage when multiple TFs fire at the same
 * time. Conservative — preserves single-account risk profile.
 */
import {
  detectAsset,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay } from "./_passDayUtils";

export interface TfEntry {
  label: "5m" | "15m" | "1h";
  cfg: FtmoDaytrade24hConfig;
  data: Record<string, Candle[]>; // candles per source-symbol
  tfHours: number;
}

/**
 * Pre-compute trades for all (TF, asset) pairs once. Returns flat sorted array
 * of trades tagged with TF source.
 */
export function precomputeAllTrades(
  tfs: TfEntry[],
): Array<Daytrade24hTrade & { tf: string }> {
  const all: Array<Daytrade24hTrade & { tf: string }> = [];
  for (const tf of tfs) {
    const crossKey = tf.cfg.crossAssetFilter?.symbol;
    const crossCandles = crossKey ? tf.data[crossKey] : undefined;
    for (const asset of tf.cfg.assets) {
      const lookupKey = asset.sourceSymbol ?? asset.symbol;
      const candles = tf.data[lookupKey];
      if (!candles) continue;
      const crossForAsset =
        crossCandles && crossCandles.length === candles.length
          ? crossCandles
          : undefined;
      const trades = detectAsset(candles, asset, tf.cfg, crossForAsset);
      for (const t of trades) all.push({ ...t, tf: tf.label });
    }
  }
  return all.sort((a, b) => a.entryTime - b.entryTime);
}

/**
 * Run unified equity loop on a window of pre-merged trades.
 *
 * Replicates the equity loop in runFtmoDaytrade24h but:
 *   - Multiple TFs share one equity track
 *   - Each trade scaled by 1/N where N = active TFs (conservative leverage)
 *   - Day index computed from window start ts
 *
 * Uses cfg5m for FTMO rules (profitTarget / DL / TL / minTradingDays / maxDays)
 * since they should be identical across TFs.
 */
export function runEnsembleWindow(
  windowTrades: Array<Daytrade24hTrade & { tf: string }>,
  windowStartTs: number,
  rulesCfg: FtmoDaytrade24hConfig,
  ensembleN: number,
): FtmoDaytrade24hResult {
  const dayMs = 24 * 3600 * 1000;
  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  let maxHold = 0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const executed: Daytrade24hTrade[] = [];
  const recentPnls: number[] = [];
  const scale = 1 / Math.max(1, ensembleN);

  for (const t of windowTrades) {
    const day = Math.floor((t.entryTime - windowStartTs) / dayMs);
    if (day < 0) continue;
    if (day >= rulesCfg.maxDays) break;
    if (!dayStart.has(day)) dayStart.set(day, equity);

    if (rulesCfg.pauseAtTargetReached && equity >= 1 + rulesCfg.profitTarget) {
      tradingDays.add(day);
      if (tradingDays.size >= rulesCfg.minTradingDays) {
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
      continue;
    }

    let factor = 1;
    if (rulesCfg.adaptiveSizing && rulesCfg.adaptiveSizing.length > 0) {
      for (const tier of rulesCfg.adaptiveSizing) {
        if (equity - 1 >= tier.equityAbove) factor = tier.factor;
      }
    }
    if (
      rulesCfg.timeBoost &&
      day >= rulesCfg.timeBoost.afterDay &&
      equity - 1 < rulesCfg.timeBoost.equityBelow &&
      rulesCfg.timeBoost.factor > factor
    ) {
      factor = rulesCfg.timeBoost.factor;
    }
    if (
      rulesCfg.kellySizing &&
      recentPnls.length >= rulesCfg.kellySizing.minTrades
    ) {
      const wins = recentPnls.filter((p) => p > 0).length;
      const wr = wins / recentPnls.length;
      let kMult = 1;
      const sortedTiers = [...rulesCfg.kellySizing.tiers].sort(
        (a, b) => b.winRateAbove - a.winRateAbove,
      );
      for (const tier of sortedTiers) {
        if (wr >= tier.winRateAbove) {
          kMult = tier.multiplier;
          break;
        }
      }
      factor *= kMult;
    }
    if (
      rulesCfg.peakDrawdownThrottle &&
      peak > 0 &&
      (peak - equity) / peak >= rulesCfg.peakDrawdownThrottle.fromPeak
    ) {
      factor = Math.min(factor, rulesCfg.peakDrawdownThrottle.factor);
    }

    // Apply ensemble scaling — preserve single-account leverage
    factor *= scale;

    if (factor <= 0) continue;
    // The trade.effPnl was computed with riskFrac=asset.riskFrac × leverage at
    // detection time. Re-derive raw PnL and apply our factor.
    const baseRiskApplied =
      Math.abs(t.effPnl) > 0
        ? t.effPnl / (t.rawPnl * (rulesCfg.leverage ?? 2))
        : 1;
    const newEffPnl = Math.max(
      t.rawPnl * (rulesCfg.leverage ?? 2) * baseRiskApplied * factor,
      -baseRiskApplied * factor,
    );
    if (rulesCfg.kellySizing) {
      recentPnls.push(newEffPnl);
      if (recentPnls.length > rulesCfg.kellySizing.windowSize)
        recentPnls.shift();
    }

    equity *= 1 + newEffPnl;
    tradingDays.add(day);
    executed.push({ ...t, effPnl: newEffPnl, day });
    if (t.holdHours > maxHold) maxHold = t.holdHours;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDd) maxDd = dd;

    if (equity <= 1 - rulesCfg.maxTotalLoss) {
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
    const sod = dayStart.get(day)!;
    if (equity / sod - 1 <= -rulesCfg.maxDailyLoss) {
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
  }

  if (
    equity >= 1 + rulesCfg.profitTarget &&
    tradingDays.size >= rulesCfg.minTradingDays
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
  if (tradingDays.size < rulesCfg.minTradingDays) {
    return {
      passed: false,
      reason: "insufficient_days",
      finalEquityPct: equity - 1,
      maxDrawdown: maxDd,
      uniqueTradingDays: tradingDays.size,
      trades: executed,
      maxHoldHoursObserved: maxHold,
    };
  }
  return {
    passed: false,
    reason: "time",
    finalEquityPct: equity - 1,
    maxDrawdown: maxDd,
    uniqueTradingDays: tradingDays.size,
    trades: executed,
    maxHoldHoursObserved: maxHold,
  };
}

/** Walk-forward over time, slicing pre-merged trades per window. */
export function walkForwardEnsemble(
  allTrades: Array<Daytrade24hTrade & { tf: string }>,
  startTs: number,
  endTs: number,
  rulesCfg: FtmoDaytrade24hConfig,
  ensembleN: number,
  challengeDays = 30,
  stepDays = 3,
) {
  const dayMs = 24 * 3600 * 1000;
  const windowMs = challengeDays * dayMs;
  const stepMs = stepDays * dayMs;
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = startTs; s + windowMs <= endTs; s += stepMs) {
    const end = s + windowMs;
    const winTrades = allTrades.filter(
      (t) => t.entryTime >= s && t.entryTime < end,
    );
    out.push(runEnsembleWindow(winTrades, s, rulesCfg, ensembleN));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out) if (r.passed) passDays.push(computePassDay(r));
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: px(0.5),
    p25Days: px(0.25),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    totalTrades: out.reduce((a, r) => a + r.trades.length, 0),
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}
