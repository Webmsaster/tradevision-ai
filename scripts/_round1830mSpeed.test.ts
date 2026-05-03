/**
 * Round 18 — switch to 30m timeframe for speed.
 *
 * 2h V5_NOVA plateau = 10d median (mathematical floor due to bar duration).
 * 30m timeframe gives 4× more bars/day → finer entry timing → potential 4-7d.
 *
 * Test V5_QUARTZ (30m, 15 assets) + V5_TITANIUM + V5_AMBER with Anti-DL.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m

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
  "Round 18 — 30m speed champions with Anti-DL",
  { timeout: 60 * 60_000 },
  () => {
    it("V5_QUARTZ/V5_TITANIUM/V5_AMBER + Anti-DL trail variations", async () => {
      const configs = [
        { name: "V5_QUARTZ", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ },
        {
          name: "V5_TITANIUM",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
        },
        { name: "V5_AMBER", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER },
        {
          name: "V5_OBSIDIAN",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
        },
      ];

      const allSymbols = new Set<string>();
      for (const c of configs) for (const s of syms(c.cfg)) allSymbols.add(s);
      console.log(`Loading ${allSymbols.size} symbols (30m)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of allSymbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "30m",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      console.log(
        `\n${"config".padEnd(15)} ${"trail".padEnd(8)} ${"variant".padEnd(10)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(85));

      const results: Array<{
        name: string;
        trail: number;
        variant: string;
        pass: number;
        med: number;
        tl: number;
      }> = [];

      for (const { name, cfg } of configs) {
        for (const td of [0.015, 0.02, 0.025, 0.03]) {
          for (const variant of ["PAUSE", "NO-PAUSE"]) {
            const cfgRun: FtmoDaytrade24hConfig = {
              ...cfg,
              liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
              dailyPeakTrailingStop: { trailDistance: td },
              pauseAtTargetReached: variant === "PAUSE",
            };
            const r = evaluate(cfgRun, data);
            if (!r) continue;
            const flag =
              r.med <= 6 && r.passRate >= 0.6
                ? " 🏆🏆🏆"
                : r.med <= 7 && r.passRate >= 0.6
                  ? " 🏆"
                  : r.med <= 8 && r.passRate >= 0.55
                    ? " ✓✓"
                    : r.med <= 10
                      ? " ✓"
                      : "";
            console.log(
              `${name.padEnd(15)} ${String(td).padEnd(8)} ${variant.padEnd(10)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p75).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
            );
            results.push({
              name,
              trail: td,
              variant,
              pass: r.passRate,
              med: r.med,
              tl: r.tlPct,
            });
          }
        }
      }

      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      const valid = results.filter((r) => r.pass >= 0.55);
      console.log("\n=== TOP-5 by lowest median (pass≥55%) ===");
      for (let i = 0; i < Math.min(5, valid.length); i++) {
        const r = valid[i];
        console.log(
          `${i + 1}. ${r.name} trail=${r.trail} ${r.variant} med=${r.med}d pass=${(r.pass * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
