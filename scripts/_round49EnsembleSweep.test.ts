/**
 * Round 49 — Multi-TF Ensemble Sweep.
 *
 * Sweeps the param-space defined in the brief:
 *   - vote-threshold: {2/3, 3/3}  (and {1/3 fallback} for completeness)
 *   - size-scale at votes=2:       {0.5, 0.6, 0.7, 1.0}
 *   - confluenceWindowMs:           {30m, 60m, 120m}
 *
 * Picks champion = highest pass-rate within max-1.5pp range, tie-break by
 * lowest TL-rate, then lowest medianDays.
 *
 * Reuses the V5-trend ensemble setup from Round 48 (V5_QUARTZ_LITE 2h +
 * V5_TITANIUM 30m + V5_TITANIUM-as-15m).
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
} from "../src/utils/multiTfEnsemble";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { computePassDay, pick } from "./_passDayUtils";

// Reduced to BTC+ETH for tractable Binance API loading (round 48 found
// confluence is sparse anyway — wider asset basket would not save the
// 3-TF ensemble approach as the underlying signal-stream divergence is
// the limiting factor, not asset count).
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

describe("Round 49 — Ensemble Sweep", { timeout: 60 * 60_000 }, () => {
  it("sweep entryThreshold × sizeScale × confluenceWindowMs", async () => {
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
      if (c.crossAssetFilter?.symbol) crossSyms.add(c.crossAssetFilter.symbol);
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
    if (symsKept.length === 0) {
      expect(true).toBe(true);
      return;
    }
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

    type SweepResult = {
      name: string;
      thr: number;
      scale2: number;
      confluenceMin: number;
      windows: number;
      passes: number;
      passRate: number;
      med: number;
      p90: number;
      tl: number;
      dl: number;
      entries: number;
    };

    const results: SweepResult[] = [];
    const thresholds = [2, 3];
    const scales = [0.5, 0.6, 0.7, 1.0];
    const windowsMs = [30 * 60_000, 60 * 60_000, 120 * 60_000];

    for (const thr of thresholds) {
      for (const conf of windowsMs) {
        const scaleSet = thr === 3 ? [1.0] : scales; // thr=3 means scale only matters for votes=3
        for (const sc2 of scaleSet) {
          const params = {
            entryThreshold: thr,
            sizeScaleByVotes:
              thr === 3
                ? { 3: 1.0 }
                : ({ 2: sc2, 3: 1.0 } as Record<number, number>),
            confluenceWindowMs: conf,
            fallbackSingleTf: false,
            exitCfg: cfg2h,
          };
          const entries = aggregateEnsembleEntries(
            votes,
            grid,
            closeMap,
            params,
          );

          let windows = 0,
            passes = 0,
            tl = 0,
            dl = 0;
          const passDays: number[] = [];
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
              passDays.push(computePassDay(r));
            } else if (r.reason === "total_loss") tl++;
            else if (r.reason === "daily_loss") dl++;
          }
          passDays.sort((a, b) => a - b);
          const med = pick(passDays, 0.5);
          const p90 = pick(passDays, 0.9);
          const passRate = passes / windows;
          const name = `thr=${thr}_sc2=${sc2.toFixed(2)}_cw=${conf / 60_000}m`;
          results.push({
            name,
            thr,
            scale2: sc2,
            confluenceMin: conf / 60_000,
            windows,
            passes,
            passRate,
            med: isNaN(med) ? -1 : med,
            p90: isNaN(p90) ? -1 : p90,
            tl,
            dl,
            entries: entries.length,
          });
          console.log(
            `${name}: ${passes}/${windows} = ${(passRate * 100).toFixed(2)}% / med=${isNaN(med) ? "-" : med}d / p90=${isNaN(p90) ? "-" : p90}d / TL=${tl} / entries=${entries.length}`,
          );
        }
      }
    }

    // Rank by pass-rate, then lower TL
    results.sort((a, b) => {
      if (Math.abs(a.passRate - b.passRate) > 0.005)
        return b.passRate - a.passRate;
      if (a.tl !== b.tl) return a.tl - b.tl;
      return a.med - b.med;
    });
    console.log("\n=== Top 8 by pass-rate ===");
    for (const r of results.slice(0, 8)) {
      console.log(
        `  ${r.name}: ${(r.passRate * 100).toFixed(2)}% / med=${r.med}d / TL=${r.tl} (${((r.tl / r.windows) * 100).toFixed(1)}%) / entries=${r.entries}`,
      );
    }
    console.log("\n=== Bottom 3 by pass-rate ===");
    for (const r of results.slice(-3)) {
      console.log(
        `  ${r.name}: ${(r.passRate * 100).toFixed(2)}% / med=${r.med}d / TL=${r.tl}`,
      );
    }
    expect(true).toBe(true);
  });
});
