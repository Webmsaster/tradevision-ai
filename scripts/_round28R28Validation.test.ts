/**
 * Round 28 — V5_QUARTZ_LITE_R28 robustness validation.
 *
 * Champion: dpt0.012 + ptp{0.025, 0.60} + liveMode=true → 71.28% on 5.71y.
 *
 * Validate via:
 *   1. Walk-forward TRAIN (first 70%) / TEST (last 30%) split
 *   2. Year-by-year pass-rates (year_2020..2026)
 *   3. Bootstrap 95% CI (1000 resamples)
 *   4. Compare to baseline V5_QUARTZ_LITE under liveMode=true
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

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

describe(
  "Round 28 — V5_QUARTZ_LITE_R28 robustness",
  { timeout: 120 * 60_000 },
  () => {
    it("walk-forward + year-by-year + bootstrap CI", async () => {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      };
      const cfgBase: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
        liveMode: true,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      } as FtmoDaytrade24hConfig;

      const symbols = syms(cfg);
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
      const winBars = cfg.maxDays * bpd;
      const stepBars = 3 * bpd;
      const ts0 = aligned[symbols[0]][0].openTime;
      const lastTs = aligned[symbols[0]][minBars - 1].openTime;
      console.log(
        `Data: ${minBars} bars / ${((lastTs - ts0) / (365 * 24 * 3600_000)).toFixed(2)}y`,
      );
      console.log(
        `Range: ${new Date(ts0).toISOString().slice(0, 10)} → ${new Date(lastTs).toISOString().slice(0, 10)}`,
      );

      type WindowResult = {
        startTs: number;
        passed: boolean;
        passDay: number;
        reason: string;
      };
      function runWindows(c: FtmoDaytrade24hConfig): WindowResult[] {
        const out: WindowResult[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
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

      console.log(`\n=== Running R28 over all windows ===`);
      const r28 = runWindows(cfg);
      const r28Pass = r28.filter((w) => w.passed).length;
      console.log(
        `R28 total: ${r28Pass}/${r28.length} = ${((r28Pass / r28.length) * 100).toFixed(2)}%`,
      );

      console.log(
        `\n=== Running BASE (V5_QUARTZ_LITE liveMode=true) for comparison ===`,
      );
      const base = runWindows(cfgBase);
      const basePass = base.filter((w) => w.passed).length;
      console.log(
        `BASE total: ${basePass}/${base.length} = ${((basePass / base.length) * 100).toFixed(2)}%`,
      );
      console.log(
        `R28 lift: +${((r28Pass / r28.length - basePass / base.length) * 100).toFixed(2)}pp`,
      );

      // Walk-forward TRAIN / TEST split
      const trainCut = Math.floor(r28.length * 0.7);
      const r28Train = r28.slice(0, trainCut);
      const r28Test = r28.slice(trainCut);
      const trainPct =
        (r28Train.filter((w) => w.passed).length / r28Train.length) * 100;
      const testPct =
        (r28Test.filter((w) => w.passed).length / r28Test.length) * 100;
      console.log(`\n=== Walk-Forward (R28) ===`);
      console.log(
        `TRAIN (first 70%, ${r28Train.length} windows): ${trainPct.toFixed(2)}%`,
      );
      console.log(
        `TEST  (last 30%, ${r28Test.length} windows): ${testPct.toFixed(2)}%`,
      );
      console.log(`Δ: ${(testPct - trainPct).toFixed(2)}pp`);

      // Year-by-year (UTC year of window-start)
      console.log(`\n=== Year-by-Year (R28) ===`);
      const years: Record<number, { p: number; w: number }> = {};
      for (const w of r28) {
        const y = new Date(w.startTs).getUTCFullYear();
        if (!years[y]) years[y] = { p: 0, w: 0 };
        years[y].w++;
        if (w.passed) years[y].p++;
      }
      for (const y of Object.keys(years).sort()) {
        const v = years[+y];
        console.log(`${y}: ${v.p}/${v.w} = ${((v.p / v.w) * 100).toFixed(2)}%`);
      }

      // Bootstrap 95% CI (1000 resamples)
      const passes: number[] = r28.map((w) => (w.passed ? 1 : 0));
      const N = passes.length;
      const samples: number[] = [];
      let seed = 1;
      function rand() {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      }
      for (let i = 0; i < 1000; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) s += passes[Math.floor(rand() * N)];
        samples.push((s / N) * 100);
      }
      samples.sort((a, b) => a - b);
      const ci_lo = samples[25];
      const ci_hi = samples[974];
      console.log(`\n=== Bootstrap 95% CI ===`);
      console.log(
        `Mean: ${((r28Pass / r28.length) * 100).toFixed(2)}%, CI: [${ci_lo.toFixed(2)}, ${ci_hi.toFixed(2)}]`,
      );

      expect(r28Pass / r28.length).toBeGreaterThan(0.69);
    });
  },
);
