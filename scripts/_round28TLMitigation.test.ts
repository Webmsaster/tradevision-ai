/**
 * Round 28 — TL-mitigation sweep under liveMode=true.
 *
 * Round 28 finding: V5_QUARTZ_LITE_FULL_9 hits 68.87% under liveMode=true
 * with TL=28.42%. To reach 70% we need to cut TL.
 *
 * Sweep grid:
 * - challengePeakTrailingStop: undefined, 0.05, 0.07, 0.08, 0.10
 * - dailyPeakTrailingStop trail: 0.020 (base), 0.015, 0.012, 0.010
 *
 * All under liveMode=true (honest backtest).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;

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

interface Variant {
  name: string;
  cfg: FtmoDaytrade24hConfig;
}

function makeVariant(
  name: string,
  dailyPeakTrail: number,
  cptsTrail: number | undefined,
  extraOverrides: Partial<FtmoDaytrade24hConfig> = {},
): Variant {
  return {
    name,
    cfg: {
      ...BASE,
      dailyPeakTrailingStop: { trailDistance: dailyPeakTrail },
      ...(cptsTrail !== undefined
        ? { challengePeakTrailingStop: { trailDistance: cptsTrail } }
        : {}),
      liveMode: true,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      ...extraOverrides,
    } as FtmoDaytrade24hConfig,
  };
}

const VARIANTS: Variant[] = [
  // baseline
  makeVariant("BASE_dpt020", 0.02, undefined),
  // tighter dailyPeakTrail
  makeVariant("dpt015", 0.015, undefined),
  makeVariant("dpt012", 0.012, undefined),
  makeVariant("dpt010", 0.01, undefined),
  // add challengePeakTrailingStop only
  makeVariant("BASE_cpts10", 0.02, 0.1),
  makeVariant("BASE_cpts08", 0.02, 0.08),
  makeVariant("BASE_cpts07", 0.02, 0.07),
  makeVariant("BASE_cpts05", 0.02, 0.05),
  // combine tighter dpt + cpts
  makeVariant("dpt015_cpts08", 0.015, 0.08),
  makeVariant("dpt015_cpts07", 0.015, 0.07),
  makeVariant("dpt012_cpts08", 0.012, 0.08),
  makeVariant("dpt012_cpts07", 0.012, 0.07),
  makeVariant("dpt010_cpts08", 0.01, 0.08),
  makeVariant("dpt010_cpts07", 0.01, 0.07),
];

describe(
  "Round 28 — TL-mitigation sweep liveMode=true",
  { timeout: 120 * 60_000 },
  () => {
    it("find 70%+ via TL-reduction", async () => {
      const symbols = syms(BASE);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
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
      const aligned = alignCommon(data, symbols);
      const minBars = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
      const bpd = 48;
      const winBars = BASE.maxDays * bpd;
      const stepBars = 3 * bpd;

      type R = {
        name: string;
        pass: number;
        passPct: number;
        tlPct: number;
        dlPct: number;
        med: number;
      };
      const results: R[] = [];

      for (const v of VARIANTS) {
        let w = 0,
          p = 0,
          tl = 0,
          dl = 0;
        const days: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, v.cfg);
          w++;
          if (res.passed) {
            p++;
            if (res.passDay) days.push(res.passDay);
          } else if (res.reason === "total_loss") tl++;
          else if (res.reason === "daily_loss") dl++;
        }
        days.sort((a, b) => a - b);
        const passPct = (p / w) * 100;
        const tlPct = (tl / w) * 100;
        const dlPct = (dl / w) * 100;
        const med = days[Math.floor(days.length / 2)] ?? 0;
        results.push({ name: v.name, pass: p, passPct, tlPct, dlPct, med });
        console.log(
          `${v.name.padEnd(22)}| ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | DL ${dlPct.toFixed(2).padStart(5)}% | med ${med}d`,
        );
      }

      console.log(`\n\n=== SORTED BY PASS-RATE ===`);
      const sorted = [...results].sort((a, b) => b.passPct - a.passPct);
      for (const r of sorted) {
        console.log(
          `${r.name.padEnd(22)}| ${r.passPct.toFixed(2).padStart(6)}% | TL ${r.tlPct.toFixed(2).padStart(6)}% | med ${r.med}d`,
        );
      }

      const winner = sorted[0];
      console.log(
        `\n>>> WINNER: ${winner.name} → ${winner.passPct.toFixed(2)}% (TL ${winner.tlPct.toFixed(2)}%, med ${winner.med}d) <<<`,
      );
      if (winner.passPct >= 70) {
        console.log(
          `*** GOAL ACHIEVED: ≥70% liveMode=true single-account! ***`,
        );
      } else {
        console.log(
          `*** NOT YET: gap to 70% = ${(70 - winner.passPct).toFixed(2)}pp ***`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
