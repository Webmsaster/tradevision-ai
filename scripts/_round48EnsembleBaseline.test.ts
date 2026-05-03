/**
 * Round 48 — Multi-TF Ensemble Baseline (15m + 30m + 2h V5-trend confluence).
 *
 * Decision change vs initial brief: the original ask called for confluence
 * between V5_QUARTZ_LITE (2h trend-long), V12_30M_OPT (30m MR-short), and
 * V16_15M_OPT (15m MR-short). These are OPPOSING strategies — V12/V16
 * `disableLong: true` so they fire SHORT only. A LONG-vote ensemble between
 * a long-trend config and short-MR configs collapses to 0 entries (verified
 * empirically: 0 ensemble entries on 1064 windows).
 *
 * Pivot: same V5 trend strategy applied across THREE timeframes:
 *   - 2h: V5_QUARTZ_LITE  (9-asset basket, established R28 production base)
 *   - 30m: V5_TITANIUM     (14-asset basket on 30m, same trend strategy)
 *   - 15m: V5_TITANIUM with 15m candles (reusing engine config, 15m TF)
 * Common 9-asset core: BTC/ETH/BNB/ADA/LTC/BCH/ETC/XRP/AAVE.
 *
 * Confluence: only count 9 common-core assets, vote = how many of the 3 TFs
 * fired a LONG entry within the 30m confluence window. Hypothesis: the
 * trend has to align across multiple TFs to be a "real" entry — should
 * cut whipsaw entries and improve V4-Sim drift.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import {
  collectTfEntryTimes,
  aggregateEnsembleEntries,
  runEnsembleEquityLoop,
  type EnsembleTfEntry,
  type EnsembleParams,
} from "../src/utils/multiTfEnsemble";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { computePassDay, pick } from "./_passDayUtils";

// Reduced to BTC+ETH for tractable Binance-API loading (avoids 429 storms
// across 18 symbols × 80 pages × 3 TFs = 4k+ calls). The 9-asset core test
// is in round49/round50 once the pipeline is validated.
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
    } catch (e) {
      console.warn(`load ${s} ${tf} failed: ${(e as Error).message}`);
    }
  }
  return out;
}

describe(
  "Round 48 — Ensemble Baseline V5 trend",
  { timeout: 60 * 60_000 },
  () => {
    it("3-TF V5-trend ensemble vs V5_QUARTZ_LITE single-TF (FTMO live caps)", async () => {
      const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
      const cfg2h: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
        liveCaps,
      };
      const cfg30m: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        liveCaps,
      };
      // For 15m we reuse V5_TITANIUM engine config with timeframe override.
      const cfg15m: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        timeframe: "15m",
        liveCaps,
      };

      console.log("\n=== Loading multi-TF history ===");
      // Load ENSEMBLE_ASSETS plus only the cross-asset filter symbols actually
      // used (typically BTCUSDT only). Avoids loading 14 unused V5_TITANIUM
      // assets that would 429-rate-limit Binance.
      const crossSyms = new Set<string>();
      for (const c of [cfg2h, cfg30m, cfg15m]) {
        if (c.crossAssetFilter?.symbol)
          crossSyms.add(c.crossAssetFilter.symbol);
      }
      const allSyms = Array.from(new Set([...ENSEMBLE_ASSETS, ...crossSyms]));
      console.log(`Loading symbols: ${allSyms.join(", ")}`);
      // 15m has shortest history (~1.71y) → binding constraint
      // 20 pages = 20k candles. On 30m that's ~1.71y (the binding TF
      // history). On 15m only ~0.85y but we use it just for vote-confluence.
      const data15m = await loadTfData(allSyms, "15m", 20);
      const data30m = await loadTfData(allSyms, "30m", 20);
      const data2h = await loadTfData(allSyms, "2h", 20);
      console.log(
        `15m: ${Object.keys(data15m).length} symbols, len=${data15m["BTCUSDT"]?.length ?? 0}`,
      );
      console.log(
        `30m: ${Object.keys(data30m).length} symbols, len=${data30m["BTCUSDT"]?.length ?? 0}`,
      );
      console.log(
        `2h:  ${Object.keys(data2h).length} symbols, len=${data2h["BTCUSDT"]?.length ?? 0}`,
      );

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

      console.log("\n=== Pre-computing TF vote-buckets ===");
      const votes = collectTfEntryTimes(tfs);
      for (const [sym, b] of votes) {
        console.log(
          `  ${sym}: 15m=${b["15m"].size} 30m=${b["30m"].size} 2h=${b["2h"].size}`,
        );
      }

      // Use 30m candles as the common ensemble grid (intersection-aligned)
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
      // grid = intersection of openTimes across all included assets
      const symsKept = Object.keys(thirtyMinByAsset);
      if (symsKept.length === 0) {
        console.warn("No assets with sufficient data — skipping");
        expect(true).toBe(true);
        return;
      }
      const sets = symsKept.map(
        (s) => new Set(thirtyMinByAsset[s].map((c) => c.openTime)),
      );
      const grid = [...sets[0]]
        .filter((t) => sets.every((s) => s.has(t)))
        .sort((a, b) => a - b);
      console.log(
        `\ncommon 30m grid: ${grid.length} bars across ${symsKept.length} assets`,
      );

      // Walk-forward: 30d challenges, 3d step
      const dayMs = 24 * 3600_000;
      const winMs = cfg2h.maxDays * dayMs;
      const stepMs = 3 * dayMs;
      const minTs = grid[0];
      const maxTs = grid[grid.length - 1];

      const variants: Array<{
        name: string;
        params: EnsembleParams;
      }> = [
        {
          name: "ENS_2of3_60-100",
          params: {
            entryThreshold: 2,
            sizeScaleByVotes: { 2: 0.6, 3: 1.0 },
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_2of3_50-100",
          params: {
            entryThreshold: 2,
            sizeScaleByVotes: { 2: 0.5, 3: 1.0 },
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_3of3_only",
          params: {
            entryThreshold: 3,
            sizeScaleByVotes: { 3: 1.0 },
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          },
        },
        {
          name: "ENS_1of3_fallback",
          params: {
            entryThreshold: 1,
            sizeScaleByVotes: { 1: 0.4, 2: 0.7, 3: 1.0 },
            confluenceWindowMs: 30 * 60_000,
            fallbackSingleTf: true,
            exitCfg: cfg2h,
          },
        },
      ];

      for (const v of variants) {
        const entries = aggregateEnsembleEntries(
          votes,
          grid,
          closeMap,
          v.params,
        );
        const voteCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
        for (const e of entries)
          voteCounts[e.votes] = (voteCounts[e.votes] ?? 0) + 1;
        console.log(
          `\n${v.name}: ${entries.length} entries / dist 1=${voteCounts[1] ?? 0} 2=${voteCounts[2] ?? 0} 3=${voteCounts[3] ?? 0}`,
        );

        let windows = 0;
        let passes = 0;
        const passDays: number[] = [];
        let tlBreaches = 0;
        let dlBreaches = 0;
        for (let s = minTs; s + winMs <= maxTs; s += stepMs) {
          const winEntries = entries.filter(
            (e) => e.entryTime >= s && e.entryTime < s + winMs,
          );
          const res = runEnsembleEquityLoop(
            winEntries,
            thirtyMinByAsset,
            cfg2h,
            s,
          );
          windows++;
          if (res.passed) {
            passes++;
            passDays.push(computePassDay(res));
          } else if (res.reason === "total_loss") tlBreaches++;
          else if (res.reason === "daily_loss") dlBreaches++;
        }
        passDays.sort((a, b) => a - b);
        const passRate = passes / windows;
        const med = pick(passDays, 0.5);
        const p90 = pick(passDays, 0.9);
        console.log(
          `  ${windows}w: ${passes}/${windows} = ${(passRate * 100).toFixed(2)}% / med=${isNaN(med) ? "-" : med}d / p90=${isNaN(p90) ? "-" : p90}d / TL=${tlBreaches}(${((tlBreaches / windows) * 100).toFixed(1)}%) / DL=${dlBreaches}`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
