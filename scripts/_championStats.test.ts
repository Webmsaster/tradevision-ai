/**
 * Champion-Stats: V5_NOVA + Anti-DL — full speed/distribution metrics.
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

describe("Champion stats — V5_NOVA Anti-DL", { timeout: 30 * 60_000 }, () => {
  it("median, p25, p75, p90 + ETA", async () => {
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

    const cfg: FtmoDaytrade24hConfig = {
      ...V5_NOVA,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      dailyPeakTrailingStop: { trailDistance: 0.015 },
    };

    const aligned = alignCommon(data, syms(cfg));
    const n = Math.min(...syms(cfg).map((s) => aligned[s]?.length ?? 0));
    const winBars = cfg.maxDays * BARS_PER_DAY;
    const stepBars = 3 * BARS_PER_DAY;

    const variants: Array<{ name: string; pause: boolean }> = [
      { name: "PAUSE", pause: true },
      { name: "NO-PAUSE", pause: false },
    ];

    for (const v of variants) {
      const cfgVar = { ...cfg, pauseAtTargetReached: v.pause };
      let windows = 0,
        passes = 0,
        tl = 0,
        dl = 0;
      const passDays: number[] = [];
      const allTrades: number[] = []; // trades per pass-window
      for (let start = 0; start + winBars <= n; start += stepBars) {
        const slice: Record<string, Candle[]> = {};
        for (const s of syms(cfg))
          slice[s] = aligned[s].slice(start, start + winBars);
        const res = runFtmoDaytrade24h(slice, cfgVar);
        windows++;
        if (res.passed) {
          passes++;
          if (res.passDay && res.passDay > 0) passDays.push(res.passDay);
          allTrades.push(res.trades.length);
        } else if (res.reason === "total_loss") tl++;
        else if (res.reason === "daily_loss") dl++;
      }
      passDays.sort((a, b) => a - b);
      const avgTradesPerPass = allTrades.length
        ? allTrades.reduce((a, b) => a + b, 0) / allTrades.length
        : 0;

      console.log(`\n=== V5_NOVA + Anti-DL trail=0.015 — ${v.name} ===`);
      console.log(`Windows:    ${windows}`);
      console.log(`Pass-Rate:  ${((passes / windows) * 100).toFixed(2)}%`);
      console.log(`TL Fails:   ${((tl / windows) * 100).toFixed(2)}%`);
      console.log(`DL Fails:   ${((dl / windows) * 100).toFixed(2)}%`);
      console.log(`\n--- Speed (pass-day distribution, days from start) ---`);
      console.log(`p25 (fast 25%):  ${pctile(passDays, 0.25)}d`);
      console.log(`p50 (MEDIAN):    ${pctile(passDays, 0.5)}d`);
      console.log(`p75:             ${pctile(passDays, 0.75)}d`);
      console.log(`p90:             ${pctile(passDays, 0.9)}d`);
      console.log(`p99:             ${pctile(passDays, 0.99)}d`);
      console.log(`min:             ${passDays[0] ?? "—"}d`);
      console.log(`max:             ${passDays[passDays.length - 1] ?? "—"}d`);
      console.log(`avg trades/pass: ${avgTradesPerPass.toFixed(1)}`);
    }
    expect(true).toBe(true);
  });
});
