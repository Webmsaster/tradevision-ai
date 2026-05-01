/**
 * Round 32 — OOS-Validation der R31-Winner.
 *
 * Nimmt die Top-3 Variants aus R31 (per ENV WINNER_CONFIGS) und validiert:
 *   - Walk-forward TRAIN (70%) / TEST (30%)
 *   - Year-by-year (2020-2026)
 *   - Bootstrap 95% CI (1000 resamples)
 *   - Vergleich gegen R28-Baseline
 *
 * Run nach R31:
 *   WINNER_CONFIGS="DROP_AAVE,CPTS_0.05,DPT_0.014" \
 *     node ./node_modules/vitest/vitest.mjs run --config vitest.scripts.config.ts \
 *     scripts/_round32ValidateWinners.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;

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

function buildVariant(name: string): FtmoDaytrade24hConfig {
  const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  if (name === "R28_BASE") {
    return { ...BASE, liveCaps };
  }
  if (name.startsWith("DROP_")) {
    const dropSym = name.substring(5) + "-TREND";
    return {
      ...BASE,
      assets: BASE.assets.filter((a) => a.symbol !== dropSym),
      liveCaps,
    };
  }
  if (name.startsWith("CPTS_")) {
    const td = parseFloat(name.substring(5));
    return {
      ...BASE,
      challengePeakTrailingStop: { trailDistance: td },
      liveCaps,
    };
  }
  if (name.startsWith("DPT_")) {
    const td = parseFloat(name.substring(4));
    return {
      ...BASE,
      dailyPeakTrailingStop: { trailDistance: td },
      liveCaps,
    };
  }
  if (name.startsWith("PTP_t")) {
    const m = name.match(/PTP_t([\d.]+)_f([\d.]+)/);
    if (!m) throw new Error(`bad name ${name}`);
    return {
      ...BASE,
      partialTakeProfit: {
        triggerPct: parseFloat(m[1]),
        closeFraction: parseFloat(m[2]),
      },
      liveCaps,
    };
  }
  // R33 winners: PTP_t0.02_f0.7 base + peakDrawdownThrottle.
  if (name.startsWith("PTP+pDD_")) {
    const m = name.match(/PTP\+pDD_([\d.]+)_([\d.]+)/);
    if (!m) throw new Error(`bad name ${name}`);
    return {
      ...BASE,
      partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
      peakDrawdownThrottle: {
        fromPeak: parseFloat(m[1]),
        factor: parseFloat(m[2]),
      },
      liveCaps,
    };
  }
  // R34 winners: R28_V2 base (PTP_t0.02_f0.7 + pDD already) but with new pDD.
  if (name.startsWith("R34_pDD_")) {
    const m = name.match(/R34_pDD_([\d.]+)_([\d.]+)/);
    if (!m) throw new Error(`bad name ${name}`);
    return {
      ...BASE,
      partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
      peakDrawdownThrottle: {
        fromPeak: parseFloat(m[1]),
        factor: parseFloat(m[2]),
      },
      liveCaps,
    };
  }
  throw new Error(`unknown variant: ${name}`);
}

describe(
  "Round 32 — OOS Validate R31 Winners",
  { timeout: 180 * 60_000 },
  () => {
    it("walk-forward + year-by-year + bootstrap CI on top winners", async () => {
      const winners = (process.env.WINNER_CONFIGS ?? "R28_BASE")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      console.log(
        `Validating ${winners.length} variants: ${winners.join(", ")}`,
      );

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
      console.log(
        `Data: ${minBars} bars / ${((aligned[symbols[0]][minBars - 1].openTime - aligned[symbols[0]][0].openTime) / (365 * 24 * 3600_000)).toFixed(2)}y`,
      );

      type WindowResult = {
        startTs: number;
        passed: boolean;
        passDay: number;
        reason: string;
      };
      function runWindows(c: FtmoDaytrade24hConfig): WindowResult[] {
        const out: WindowResult[] = [];
        const variantSymbols = syms(c);
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of variantSymbols)
            slice[s] = aligned[s]?.slice(start, start + winBars) ?? [];
          const startTs = aligned[symbols[0]][start].openTime;
          const res = runFtmoDaytrade24h(slice, c);
          out.push({
            startTs,
            passed: res.passed,
            passDay: res.passDay ?? 0,
            reason: res.reason,
          });
        }
        return out;
      }

      for (const wname of winners) {
        const cfg = buildVariant(wname);
        console.log(`\n========== ${wname} ==========`);
        const r = runWindows(cfg);
        const passes = r.filter((w) => w.passed).length;
        console.log(
          `Total: ${passes}/${r.length} = ${((passes / r.length) * 100).toFixed(2)}%`,
        );

        // Walk-forward
        const trainCut = Math.floor(r.length * 0.7);
        const train = r.slice(0, trainCut);
        const test = r.slice(trainCut);
        const trainPct =
          (train.filter((w) => w.passed).length / train.length) * 100;
        const testPct =
          (test.filter((w) => w.passed).length / test.length) * 100;
        console.log(
          `Walk-forward TRAIN: ${trainPct.toFixed(2)}% | TEST: ${testPct.toFixed(2)}% | Δ ${(testPct - trainPct).toFixed(2)}pp`,
        );

        // Year-by-year
        const years: Record<number, { p: number; w: number }> = {};
        for (const w of r) {
          const y = new Date(w.startTs).getUTCFullYear();
          if (!years[y]) years[y] = { p: 0, w: 0 };
          years[y].w++;
          if (w.passed) years[y].p++;
        }
        const yearStr = Object.keys(years)
          .sort()
          .map((y) => {
            const v = years[+y];
            return `${y}:${((v.p / v.w) * 100).toFixed(1)}%`;
          })
          .join(" ");
        console.log(`Year-by-year: ${yearStr}`);

        // Bootstrap 95% CI
        const passes_arr = r.map((w) => (w.passed ? 1 : 0));
        const N = passes_arr.length;
        let seed = 1;
        function rand() {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        }
        const samples: number[] = [];
        for (let i = 0; i < 1000; i++) {
          let s = 0;
          for (let j = 0; j < N; j++) s += passes_arr[Math.floor(rand() * N)];
          samples.push((s / N) * 100);
        }
        samples.sort((a, b) => a - b);
        console.log(
          `Bootstrap 95% CI: [${samples[25].toFixed(2)}, ${samples[974].toFixed(2)}]`,
        );
      }

      expect(winners.length).toBeGreaterThan(0);
    });
  },
);
