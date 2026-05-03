/**
 * Round 17 — PTPL accumulation + timeBoost aggressive + MCT for parallel.
 *
 * Top-3 Sizing-Brainstorm ideas:
 *   1. partialTakeProfitLevels [{1%,0.3},{2%,0.3},{4%,0.4}] — score 3.0
 *   2. timeBoost factor 2.5 (current 2.0)
 *   3. maxConcurrentTrades = 4 (currently undef)
 *
 * Sweep all combos on V5_NOVA + Anti-DL + Bug-fixed engine.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = data[s].filter((c) => cs.has(c.openTime));
  return aligned;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  return arr[Math.floor(arr.length * p)];
}

function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const passDays: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  passDays.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    p25: pctile(passDays, 0.25),
    med: pctile(passDays, 0.5),
    p75: pctile(passDays, 0.75),
    p90: pctile(passDays, 0.9),
  };
}

describe(
  "Round 17 — PTPL + timeBoost + MCT speed combos",
  { timeout: 60 * 60_000 },
  () => {
    it("test PTPL accumulation strategies", async () => {
      const V5_NOVA = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA;
      const symbols = syms(V5_NOVA);
      console.log(`Loading ${symbols.length} symbols (2h)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      const baseAntiDL: FtmoDaytrade24hConfig = {
        ...V5_NOVA,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.015 },
        pauseAtTargetReached: true,
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
      trials.push({ name: "BASELINE", cfg: baseAntiDL });

      // PTPL variants
      const ptplVariants = [
        {
          name: "PTPL [1%,0.3][2%,0.3][4%,0.4]",
          levels: [
            { triggerPct: 0.01, closeFraction: 0.3 },
            { triggerPct: 0.02, closeFraction: 0.3 },
            { triggerPct: 0.04, closeFraction: 0.4 },
          ],
        },
        {
          name: "PTPL [1.5%,0.4][3%,0.4]",
          levels: [
            { triggerPct: 0.015, closeFraction: 0.4 },
            { triggerPct: 0.03, closeFraction: 0.4 },
          ],
        },
        {
          name: "PTPL [2%,0.5][5%,0.5]",
          levels: [
            { triggerPct: 0.02, closeFraction: 0.5 },
            { triggerPct: 0.05, closeFraction: 0.5 },
          ],
        },
      ];
      for (const v of ptplVariants) {
        trials.push({
          name: v.name,
          cfg: { ...baseAntiDL, partialTakeProfitLevels: v.levels },
        });
      }

      // timeBoost variants
      for (const f of [2.5, 3.0, 4.0]) {
        const tb = baseAntiDL.timeBoost;
        if (tb) {
          trials.push({
            name: `timeBoost factor=${f}`,
            cfg: { ...baseAntiDL, timeBoost: { ...tb, factor: f } },
          });
        }
      }

      // MCT variants
      for (const mct of [4, 6]) {
        trials.push({
          name: `maxConcurrentTrades=${mct}`,
          cfg: { ...baseAntiDL, maxConcurrentTrades: mct },
        });
      }

      // COMBOS
      trials.push({
        name: "COMBO: PTPL + tBoost=2.5 + mct=4",
        cfg: {
          ...baseAntiDL,
          partialTakeProfitLevels: ptplVariants[0].levels,
          timeBoost: baseAntiDL.timeBoost
            ? { ...baseAntiDL.timeBoost, factor: 2.5 }
            : undefined,
          maxConcurrentTrades: 4,
        },
      });
      trials.push({
        name: "COMBO: PTPL strong + tBoost=3 + mct=6",
        cfg: {
          ...baseAntiDL,
          partialTakeProfitLevels: ptplVariants[2].levels,
          timeBoost: baseAntiDL.timeBoost
            ? { ...baseAntiDL.timeBoost, factor: 3.0 }
            : undefined,
          maxConcurrentTrades: 6,
        },
      });

      console.log(
        `\n${"variant".padEnd(45)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(80));

      const results: Array<{
        name: string;
        pass: number;
        med: number;
        p25: number;
        p75: number;
        p90: number;
        tl: number;
      }> = [];

      for (const { name, cfg } of trials) {
        const r = evaluate(cfg, data);
        if (!r) continue;
        const flag =
          r.med <= 7 && r.passRate >= 0.6
            ? " 🏆🏆🏆"
            : r.med <= 9 && r.passRate >= 0.6
              ? " 🏆"
              : r.med <= 10
                ? " ✓"
                : "";
        console.log(
          `${name.padEnd(45)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p75).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p75: r.p75,
          p90: r.p90,
          tl: r.tlPct,
        });
      }

      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      const valid = results.filter((r) => r.pass >= 0.55);
      console.log("\n=== TOP-5 by lowest median (with pass>=55%) ===");
      for (let i = 0; i < Math.min(5, valid.length); i++) {
        const r = valid[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(45)} med=${r.med}d pass=${(r.pass * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
