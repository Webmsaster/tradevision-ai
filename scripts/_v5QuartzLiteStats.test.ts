/**
 * V5_QUARTZ_LITE detailed champion stats.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;

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

describe("V5_QUARTZ_LITE Champion Stats", { timeout: 30 * 60_000 }, () => {
  it("PAUSE vs NO-PAUSE detailed distribution", async () => {
    const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
    const symbols = syms(QZ);
    console.log(`Loading ${symbols.length} symbols (30m)...`);
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

    const cfgWithCaps: FtmoDaytrade24hConfig = {
      ...QZ,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    };

    const aligned = alignCommon(data, syms(cfgWithCaps));
    const n = Math.min(
      ...syms(cfgWithCaps).map((s) => aligned[s]?.length ?? 0),
    );
    const winBars = cfgWithCaps.maxDays * BARS_PER_DAY;
    const stepBars = 3 * BARS_PER_DAY;

    for (const variant of ["PAUSE", "NO-PAUSE"]) {
      const cfg = { ...cfgWithCaps, pauseAtTargetReached: variant === "PAUSE" };
      let windows = 0,
        passes = 0,
        tl = 0,
        dl = 0;
      const passDays: number[] = [];
      const tradesPerPass: number[] = [];
      for (let start = 0; start + winBars <= n; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of syms(cfgWithCaps))
          slice[s] = aligned[s].slice(start, start + winBars);
        const res = runFtmoDaytrade24h(slice, cfg);
        windows++;
        if (res.passed) {
          passes++;
          if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
          tradesPerPass.push(res.trades.length);
        } else if (res.reason === "total_loss") tl++;
        else if (res.reason === "daily_loss") dl++;
      }
      passDays.sort((a, b) => a - b);

      console.log(`\n=== V5_QUARTZ_LITE — ${variant} ===`);
      console.log(
        `Windows: ${windows} / Passes: ${passes} (${((passes / windows) * 100).toFixed(2)}%)`,
      );
      console.log(
        `TL: ${((tl / windows) * 100).toFixed(2)}% / DL: ${((dl / windows) * 100).toFixed(2)}%`,
      );
      console.log(`\n--- Pass-Day distribution ---`);
      console.log(`min:    ${passDays[0]}d`);
      console.log(`p10:    ${pctile(passDays, 0.1)}d`);
      console.log(`p25:    ${pctile(passDays, 0.25)}d`);
      console.log(`p50:    ${pctile(passDays, 0.5)}d (MEDIAN)`);
      console.log(`p75:    ${pctile(passDays, 0.75)}d`);
      console.log(`p90:    ${pctile(passDays, 0.9)}d`);
      console.log(`p99:    ${pctile(passDays, 0.99)}d`);
      console.log(`max:    ${passDays[passDays.length - 1]}d`);
      console.log(
        `avg trades/pass: ${(tradesPerPass.reduce((a, b) => a + b, 0) / tradesPerPass.length).toFixed(1)}`,
      );
      // Histogram
      const buckets: Record<number, number> = {};
      for (const d of passDays) buckets[d] = (buckets[d] ?? 0) + 1;
      console.log(`\nDay-distribution histogram:`);
      for (let d = 1; d <= 10; d++) {
        const count = buckets[d] ?? 0;
        const pct = ((count / passDays.length) * 100).toFixed(1);
        const bar = "█".repeat(Math.round(count / 5));
        console.log(
          `  ${String(d).padStart(2)}d: ${String(count).padStart(3)} (${pct}%) ${bar}`,
        );
      }
    }

    expect(true).toBe(true);
  });
});
