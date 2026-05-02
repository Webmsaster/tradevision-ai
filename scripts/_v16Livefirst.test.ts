/**
 * V16_LIVEFIRST — V16_15M_OPT minus all state-dependent / drift-creating
 * features. Goal: prove a 15m config can hit ≥80% backtest WITHOUT relying on
 * pauseAtTargetReached / kellySizing / dailyPeakTrailingStop /
 * challengePeakTrailingStop / correlationFilter — i.e. features that DON'T
 * survive the live polling architecture (state not persisted between ticks).
 *
 * Round 28 hypothesis: V16's 94.38% requires pauseAtTargetReached (inherited
 * from V236). Strip it and see what's left. If we still clear ≥80%, the live
 * pass-rate floor is far higher than V231's 0% entry-agreement and matches
 * the 70%+ goal once doubled accounts are stacked.
 *
 * Asset baskets tested:
 *   1) V16_LIVEFIRST       — V16's native ETH/BTC/SOL basket
 *   2) V16_LIVEFIRST_QUARTZ — V16 stack ported to V5_QUARTZ_LITE 9-asset basket
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay, assertAligned } from "./_passDayUtils";

const CHALLENGE_DAYS = 30;
const BARS_PER_DAY_15M = 96;

interface BatchResult {
  passes: number;
  windows: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
}

// Build the LIVEFIRST stack: take V16 as-is then NULL OUT every drift feature.
function stripDriftFeatures(
  base: FtmoDaytrade24hConfig,
): FtmoDaytrade24hConfig {
  return {
    ...base,
    pauseAtTargetReached: false,
    kellySizing: undefined,
    dailyPeakTrailingStop: undefined,
    challengePeakTrailingStop: undefined,
    correlationFilter: undefined,
  };
}

const V16_LIVEFIRST: FtmoDaytrade24hConfig = stripDriftFeatures(
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
);

// Port the V16 engine stack onto V5_QUARTZ_LITE 9-asset basket.
const V16_LIVEFIRST_QUARTZ: FtmoDaytrade24hConfig = stripDriftFeatures({
  ...FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE.assets,
});

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  assertAligned(byAsset);
  const winBars = CHALLENGE_DAYS * BARS_PER_DAY_15M;
  const stepBars = stepDays * BARS_PER_DAY_15M;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out) {
    if (r.passed) passDays.push(computePassDay(r));
  }
  passDays.sort((a, b) => a - b);
  const px = (q: number) => {
    const v = pick(passDays, q);
    return Number.isNaN(v) ? 0 : v;
  };
  return {
    passes,
    windows: out.length,
    passRate: out.length === 0 ? 0 : passes / out.length,
    medianDays: px(0.5),
    p75Days: px(0.75),
    p90Days: px(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
  };
}

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(34)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}`;
}

describe(
  "V16_LIVEFIRST — drift-feature-free 15m backtest",
  { timeout: 1800_000 },
  () => {
    it("loads 15m bars and runs walk-forward on V16, V16_LIVEFIRST, V16_LIVEFIRST_QUARTZ", async () => {
      // V16 was validated on 5.71y, but loading max history × 10 assets is slow.
      // Use 50k bars (~1.4y) — enough for ~470 walk-forward windows on step=3d.
      const targetCount = 50000;
      const maxPages = 50;

      console.log(
        `\n=== Loading 15m bars (target=${targetCount} per asset) ===`,
      );
      const symbols = [
        "ETHUSDT",
        "BTCUSDT",
        "SOLUSDT",
        "BNBUSDT",
        "ADAUSDT",
        "LTCUSDT",
        "BCHUSDT",
        "ETCUSDT",
        "XRPUSDT",
        "AAVEUSDT",
      ];
      const candles: Record<string, Candle[]> = {};
      for (const s of symbols) {
        candles[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount,
          maxPages,
        });
        const yrs = (candles[s].length / BARS_PER_DAY_15M / 365).toFixed(2);
        console.log(`  ${s}: ${candles[s].length} bars (${yrs}y)`);
      }

      // Align by openTime intersection (different listing dates / dropped bars)
      const tsCounts = new Map<number, number>();
      for (const s of symbols) {
        for (const c of candles[s])
          tsCounts.set(c.openTime, (tsCounts.get(c.openTime) || 0) + 1);
      }
      const commonTs = new Set<number>();
      for (const [t, n] of tsCounts) if (n === symbols.length) commonTs.add(t);
      for (const s of symbols)
        candles[s] = candles[s].filter((c) => commonTs.has(c.openTime));
      // Sort by openTime to be safe
      for (const s of symbols)
        candles[s].sort((a, b) => a.openTime - b.openTime);
      const minLen = Math.min(...Object.values(candles).map((c) => c.length));
      for (const s of symbols) candles[s] = candles[s].slice(-minLen);
      const yrs = (minLen / BARS_PER_DAY_15M / 365).toFixed(2);
      console.log(
        `  → aligned: ${minLen} bars (${yrs}y, ~${Math.floor(minLen / BARS_PER_DAY_15M)} days)`,
      );

      // Basket 1: ETH+BTC+SOL (V16 native)
      const ethBtcSol: Record<string, Candle[]> = {
        ETHUSDT: candles.ETHUSDT,
        BTCUSDT: candles.BTCUSDT,
        SOLUSDT: candles.SOLUSDT,
      };

      // Basket 2: V5_QUARTZ_LITE 9-asset basket
      // V5_QUARTZ_LITE assets list source-symbols via sourceSymbol field.
      const quartzSourceSyms = new Set(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE.assets.map(
          (a) => a.sourceSymbol,
        ),
      );
      const quartzBasket: Record<string, Candle[]> = {};
      for (const s of symbols) {
        if (quartzSourceSyms.has(s)) quartzBasket[s] = candles[s];
      }
      console.log(
        `  V5_QUARTZ_LITE basket → ${Object.keys(quartzBasket).join(",")}`,
      );

      console.log(`\n=== WALK-FORWARD (step=3d) ===`);
      const baseline = runWalkForward(
        ethBtcSol,
        FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
      );
      console.log(fmt("V16 (baseline, all features)", baseline));

      const lf = runWalkForward(ethBtcSol, V16_LIVEFIRST);
      console.log(fmt("V16_LIVEFIRST (no drift)", lf));

      const lfQuartz = runWalkForward(quartzBasket, V16_LIVEFIRST_QUARTZ);
      console.log(fmt("V16_LIVEFIRST_QUARTZ", lfQuartz));

      console.log(`\n=== ABLATIONS (which feature carried V16?) ===`);
      // Each ablation re-introduces ONE feature on top of LIVEFIRST.
      const v16 = FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT;
      const ablations: { label: string; cfg: FtmoDaytrade24hConfig }[] = [
        {
          label: "  + pauseAtTargetReached",
          cfg: { ...V16_LIVEFIRST, pauseAtTargetReached: true },
        },
        {
          label: "  + kellySizing",
          cfg: { ...V16_LIVEFIRST, kellySizing: v16.kellySizing },
        },
        {
          label: "  + dailyPeakTrailingStop",
          cfg: {
            ...V16_LIVEFIRST,
            dailyPeakTrailingStop: v16.dailyPeakTrailingStop,
          },
        },
        {
          label: "  + challengePeakTrailingStop",
          cfg: {
            ...V16_LIVEFIRST,
            challengePeakTrailingStop: v16.challengePeakTrailingStop,
          },
        },
        {
          label: "  + correlationFilter",
          cfg: {
            ...V16_LIVEFIRST,
            correlationFilter: v16.correlationFilter,
          },
        },
      ];
      for (const a of ablations) {
        const r = runWalkForward(ethBtcSol, a.cfg);
        console.log(fmt(a.label, r));
      }

      console.log(`\n=== SUMMARY ===`);
      const drift = baseline.passRate - lf.passRate;
      console.log(
        `  Δ V16 → V16_LIVEFIRST: ${(drift * 100).toFixed(2)}pp  (drift cost)`,
      );
      console.log(
        `  V16_LIVEFIRST goal ≥80%: ${lf.passRate >= 0.8 ? "PASS" : "MISS"}`,
      );
      console.log(
        `  V16_LIVEFIRST_QUARTZ goal ≥80%: ${lfQuartz.passRate >= 0.8 ? "PASS" : "MISS"}`,
      );

      expect(baseline.windows).toBeGreaterThan(10);
    });
  },
);
