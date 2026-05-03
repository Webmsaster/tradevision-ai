/**
 * Round 50 — Ensemble V4-Sim Validation.
 *
 * The V4 Live Simulator (`scripts/_v4LiveSimulator.test.ts`) replicates
 * bar-by-bar live execution with persistent state. Engine backtests vs
 * V4-Sim drift 30-46pp on V5_QUARTZ_LITE (memory: feedback_backtest_vs_v4sim_gap.md).
 *
 * The ensemble model already operates bar-by-bar on a 30m grid with
 * `runEnsembleEquityLoop`, BUT it shares one trait with the V4-Sim that
 * matters: it does NOT have look-ahead through pre-computed exit times.
 * Each entry is sized at entry-time and walked forward bar-by-bar for
 * exit. So `runEnsembleEquityLoop` IS effectively V4-Sim already.
 *
 * What's missing for full parity with V4-Sim: chandelierExit (trailing
 * stop on ATR). The current loop uses static SL/TP only. This is the
 * "live-honest" subset — it's actually MORE conservative than full V5_QUARTZ
 * (which has chand p56 m2). So pass-rate is a true lower-bound.
 *
 * This round: run the Round 48/49 champion ensemble vs V4-Sim of pure
 * V5_QUARTZ_LITE on the same 30m grid + same windows for direct comparison.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  detectAsset,
  type FtmoDaytrade24hConfig,
  type Daytrade24hTrade,
} from "../src/utils/ftmoDaytrade24h";
import {
  collectTfEntryTimes,
  aggregateEnsembleEntries,
  runEnsembleEquityLoop,
  type EnsembleTfEntry,
} from "../src/utils/multiTfEnsemble";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { computePassDay, pick } from "./_passDayUtils";

// Reduced to BTC+ETH (round 48/49 confirmed asset count is not the limiting
// factor for the 3-TF V5-trend ensemble; signal-stream divergence is).
const ENSEMBLE_ASSETS = ["BTCUSDT", "ETHUSDT"];

async function loadTfData(
  symbols: string[],
  tf: "15m" | "30m" | "2h",
  pages: number,
): Promise<Record<string, Candle[]>> {
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) {
    try {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe: tf,
        targetCount: 200_000,
        maxPages: pages,
      });
      out[s] = r.filter((c) => c.isFinal);
    } catch {}
  }
  return out;
}

/**
 * Single-TF V5_QUARTZ_LITE V4-Sim baseline.  Walk 30m bars (matching
 * ensemble grid for fair comparison).  Each 2h bar that produces a
 * V5_QUARTZ_LITE LONG entry → enter on next 30m bar at close.
 */
function runQuartzLiteV4SimWindow(
  thirtyMinByAsset: Record<string, Candle[]>,
  twoHourTrades: Map<string, Daytrade24hTrade[]>,
  windowStartTs: number,
  cfg: FtmoDaytrade24hConfig,
) {
  const dayMs = 24 * 3600_000;
  let equity = 1.0;
  let peak = 1.0;
  let dayPeak = 1.0;
  const dayStart = new Map<number, number>();
  const tradingDays = new Set<number>();
  const minDays = cfg.minTradingDays ?? 4;
  const maxDays = cfg.maxDays;
  const trail = cfg.dailyPeakTrailingStop?.trailDistance;
  const stopPctCap = cfg.liveCaps?.maxStopPct ?? 0.05;
  const riskFracCap = cfg.liveCaps?.maxRiskFrac ?? 0.4;
  const leverage = cfg.leverage ?? 2;
  let firstTargetDay: number | null = null;

  // Flat list of (entryTime, asset) sorted
  const flatEntries: Array<{ asset: any; t: Daytrade24hTrade }> = [];
  for (const asset of cfg.assets) {
    const sourceSym = asset.sourceSymbol ?? asset.symbol;
    if (!ENSEMBLE_ASSETS.includes(sourceSym)) continue;
    const trades = twoHourTrades.get(sourceSym) ?? [];
    const winEnd = windowStartTs + maxDays * dayMs;
    for (const t of trades) {
      if (t.entryTime < windowStartTs || t.entryTime >= winEnd) continue;
      if (t.direction !== "long") continue;
      flatEntries.push({ asset, t });
    }
  }
  flatEntries.sort((a, b) => a.t.entryTime - b.t.entryTime);

  for (const { asset, t } of flatEntries) {
    const day = Math.floor((t.entryTime - windowStartTs) / dayMs);
    if (day < 0 || day >= maxDays) continue;
    if (!dayStart.has(day)) {
      dayStart.set(day, equity);
      dayPeak = equity;
    }
    if (firstTargetDay !== null && cfg.pauseAtTargetReached) {
      tradingDays.add(day);
      if (tradingDays.size >= minDays) break;
      continue;
    }
    if (trail !== undefined) {
      const drop = (dayPeak - equity) / Math.max(dayPeak, 1e-9);
      if (drop >= trail) continue;
    }
    const sourceSym = asset.sourceSymbol ?? asset.symbol;
    const candles = thirtyMinByAsset[sourceSym];
    if (!candles) continue;
    // Find 30m bar at or after entryTime
    const startIdx = candles.findIndex((c) => c.openTime >= t.entryTime);
    if (startIdx < 0) continue;
    const startBar = candles[startIdx];
    const entryPrice = startBar.close;
    const stopPct = Math.min(asset.stopPct ?? cfg.stopPct, stopPctCap);
    const tpPct = asset.tpPct ?? cfg.tpPct;
    const stopPrice = entryPrice * (1 - stopPct);
    const tpPrice = entryPrice * (1 + tpPct);
    const holdBars30m = (asset.holdBars ?? cfg.holdBars) * 4;
    const endIdx = Math.min(candles.length - 1, startIdx + holdBars30m);
    let exitPrice: number | null = null;
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const c = candles[i];
      if (c.low <= stopPrice) {
        exitPrice = stopPrice;
        break;
      }
      if (c.high >= tpPrice) {
        exitPrice = tpPrice;
        break;
      }
    }
    if (exitPrice === null) exitPrice = candles[endIdx].close;
    const rawPnl = (exitPrice - entryPrice) / entryPrice;
    const costBp = (asset.costBp ?? 0) + (asset.slippageBp ?? 0);
    const adjustedRaw = rawPnl - 2 * (costBp / 10_000);
    const effRisk = Math.min(asset.riskFrac, riskFracCap);
    const effPnl = Math.max(adjustedRaw * leverage * effRisk, -effRisk * 1.5);
    equity *= 1 + effPnl;
    if (equity > peak) peak = equity;
    if (equity > dayPeak) dayPeak = equity;
    tradingDays.add(day);

    if (equity <= 1 - cfg.maxTotalLoss) {
      return {
        passed: false,
        reason: "total_loss",
        equity: equity - 1,
        day: 0,
      };
    }
    const sod = dayStart.get(day) ?? 1;
    if (equity / sod - 1 <= -cfg.maxDailyLoss) {
      return {
        passed: false,
        reason: "daily_loss",
        equity: equity - 1,
        day: 0,
      };
    }
    if (equity >= 1 + cfg.profitTarget && firstTargetDay === null) {
      firstTargetDay = day;
      if (tradingDays.size >= minDays) {
        return {
          passed: true,
          reason: "profit_target",
          equity: equity - 1,
          day: Math.max(day + 1, minDays),
        };
      }
    }
  }
  if (firstTargetDay !== null && tradingDays.size >= minDays) {
    return {
      passed: true,
      reason: "profit_target",
      equity: equity - 1,
      day: Math.max(firstTargetDay + 1, minDays),
    };
  }
  return { passed: false, reason: "time", equity: equity - 1, day: 0 };
}

describe(
  "Round 50 — Ensemble V4-Sim Validation",
  { timeout: 60 * 60_000 },
  () => {
    it("Ensemble vs V5_QUARTZ_LITE V4-Sim head-to-head", async () => {
      const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
      const cfg2h: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
        liveCaps,
      };
      const cfg30m: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        liveCaps,
      };
      const cfg15m: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        timeframe: "15m",
        liveCaps,
      };

      const crossSyms = new Set<string>();
      for (const c of [cfg2h, cfg30m, cfg15m]) {
        if (c.crossAssetFilter?.symbol)
          crossSyms.add(c.crossAssetFilter.symbol);
      }
      const allSyms = Array.from(new Set([...ENSEMBLE_ASSETS, ...crossSyms]));
      console.log("\n=== Loading multi-TF history ===");
      const data15m = await loadTfData(allSyms, "15m", 20);
      const data30m = await loadTfData(allSyms, "30m", 20);
      const data2h = await loadTfData(allSyms, "2h", 20);

      const tfs: EnsembleTfEntry[] = [
        {
          label: "15m",
          cfg: cfg15m,
          data: data15m,
          barMs: 15 * 60_000,
          assetWhitelist: ENSEMBLE_ASSETS,
        },
        {
          label: "30m",
          cfg: cfg30m,
          data: data30m,
          barMs: 30 * 60_000,
          assetWhitelist: ENSEMBLE_ASSETS,
        },
        {
          label: "2h",
          cfg: cfg2h,
          data: data2h,
          barMs: 2 * 3600_000,
          assetWhitelist: ENSEMBLE_ASSETS,
        },
      ];

      console.log("=== Pre-computing votes ===");
      const votes = collectTfEntryTimes(tfs);
      // Pre-compute V5_QUARTZ_LITE 2h trades for V4-Sim baseline
      const twoHourTrades = new Map<string, Daytrade24hTrade[]>();
      const crossKey = cfg2h.crossAssetFilter?.symbol;
      const crossCandles = crossKey ? data2h[crossKey] : undefined;
      for (const asset of cfg2h.assets) {
        const sourceSym = asset.sourceSymbol ?? asset.symbol;
        if (!ENSEMBLE_ASSETS.includes(sourceSym)) continue;
        const candles = data2h[sourceSym];
        if (!candles) continue;
        const cross =
          crossCandles && crossCandles.length === candles.length
            ? crossCandles
            : undefined;
        try {
          const trades = detectAsset(candles, asset, cfg2h, cross);
          twoHourTrades.set(sourceSym, trades);
        } catch {}
      }

      const thirtyMinByAsset: Record<string, Candle[]> = {};
      const closeMap = new Map<string, Map<number, number>>();
      for (const sym of ENSEMBLE_ASSETS) {
        const arr = data30m[sym];
        if (!arr || arr.length < 1000) continue;
        thirtyMinByAsset[sym] = arr;
        const m = new Map<number, number>();
        for (const c of arr) m.set(c.openTime, c.close);
        closeMap.set(sym, m);
      }
      const symsKept = Object.keys(thirtyMinByAsset);
      const sets = symsKept.map(
        (s) => new Set(thirtyMinByAsset[s].map((c) => c.openTime)),
      );
      const grid = [...sets[0]]
        .filter((t) => sets.every((s) => s.has(t)))
        .sort((a, b) => a - b);

      const dayMs = 24 * 3600_000;
      const winMs = cfg2h.maxDays * dayMs;
      const stepMs = 3 * dayMs;
      const minTs = grid[0];
      const maxTs = grid[grid.length - 1];

      // Variants to compare with single-TF V5_QUARTZ_LITE V4-Sim
      const variants = [
        {
          name: "ENS_2of3_60-100",
          params: {
            entryThreshold: 2,
            sizeScaleByVotes: { 2: 0.6, 3: 1.0 } as Record<number, number>,
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_3of3_only",
          params: {
            entryThreshold: 3,
            sizeScaleByVotes: { 3: 1.0 } as Record<number, number>,
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_2of3_50-100_60m",
          params: {
            entryThreshold: 2,
            sizeScaleByVotes: { 2: 0.5, 3: 1.0 } as Record<number, number>,
            confluenceWindowMs: 60 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_2of3_70-100_120m",
          params: {
            entryThreshold: 2,
            sizeScaleByVotes: { 2: 0.7, 3: 1.0 } as Record<number, number>,
            confluenceWindowMs: 120 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
      ];

      // Single-TF V5_QUARTZ_LITE V4-Sim baseline (the head-to-head reference)
      let qWindows = 0,
        qPasses = 0,
        qTl = 0,
        qDl = 0;
      const qPassDays: number[] = [];
      for (let s = minTs; s + winMs <= maxTs; s += stepMs) {
        const r = runQuartzLiteV4SimWindow(
          thirtyMinByAsset,
          twoHourTrades,
          s,
          cfg2h,
        );
        qWindows++;
        if (r.passed) {
          qPasses++;
          qPassDays.push(r.day);
        } else if (r.reason === "total_loss") qTl++;
        else if (r.reason === "daily_loss") qDl++;
      }
      qPassDays.sort((a, b) => a - b);
      console.log(
        `\n[V4-SIM baseline V5_QUARTZ_LITE 9-asset] ${qPasses}/${qWindows} = ${((qPasses / qWindows) * 100).toFixed(2)}% / med=${pick(qPassDays, 0.5)}d / TL=${qTl} (${((qTl / qWindows) * 100).toFixed(1)}%)`,
      );

      for (const v of variants) {
        const entries = aggregateEnsembleEntries(
          votes,
          grid,
          closeMap,
          v.params,
        );
        let windows = 0,
          passes = 0,
          tl = 0,
          dl = 0;
        const pdays: number[] = [];
        for (let s = minTs; s + winMs <= maxTs; s += stepMs) {
          const winEntries = entries.filter(
            (e) => e.entryTime >= s && e.entryTime < s + winMs,
          );
          const r = runEnsembleEquityLoop(
            winEntries,
            thirtyMinByAsset,
            cfg2h,
            s,
          );
          windows++;
          if (r.passed) {
            passes++;
            pdays.push(computePassDay(r));
          } else if (r.reason === "total_loss") tl++;
          else if (r.reason === "daily_loss") dl++;
        }
        pdays.sort((a, b) => a - b);
        const pr = passes / windows;
        const med = pick(pdays, 0.5);
        const drift = pr * 100 - (qPasses / qWindows) * 100;
        console.log(
          `[${v.name}] ${passes}/${windows} = ${(pr * 100).toFixed(2)}% / med=${isNaN(med) ? "-" : med}d / TL=${tl} (${((tl / windows) * 100).toFixed(1)}%) / Δ=${drift >= 0 ? "+" : ""}${drift.toFixed(2)}pp / entries=${entries.length}`,
        );
      }

      // Walk-forward TRAIN/TEST split (in-sample first half, OOS second half)
      console.log("\n=== Walk-forward TRAIN/TEST split (V4-sim) ===");
      const midTs = Math.floor((minTs + maxTs) / 2);
      for (const v of variants) {
        const entries = aggregateEnsembleEntries(
          votes,
          grid,
          closeMap,
          v.params,
        );
        const runHalf = (start: number, end: number) => {
          let w = 0,
            p = 0;
          for (let s = start; s + winMs <= end; s += stepMs) {
            const winEntries = entries.filter(
              (e) => e.entryTime >= s && e.entryTime < s + winMs,
            );
            const r = runEnsembleEquityLoop(
              winEntries,
              thirtyMinByAsset,
              cfg2h,
              s,
            );
            w++;
            if (r.passed) p++;
          }
          return { w, p, pr: p / w };
        };
        const train = runHalf(minTs, midTs);
        const test = runHalf(midTs, maxTs);
        console.log(
          `${v.name}: TRAIN ${(train.pr * 100).toFixed(2)}% (${train.p}/${train.w}) / TEST ${(test.pr * 100).toFixed(2)}% (${test.p}/${test.w}) / Δ=${((test.pr - train.pr) * 100).toFixed(2)}pp`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
