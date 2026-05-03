/**
 * V5_QUARTZ_LITE — Ping Reliability Test
 *
 * Round 22 found Tag-4 cluster is pingtrade-inflation artifact.
 * Test pass-rate + median across pingReliability values.
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

describe(
  "V5_QUARTZ_LITE Ping Reliability Test",
  { timeout: 30 * 60_000 },
  () => {
    it("test pass-rate + median across pingReliability", async () => {
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

      const baseCfg: FtmoDaytrade24hConfig = {
        ...QZ,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        pauseAtTargetReached: true,
      };

      const aligned = alignCommon(data, syms(baseCfg));
      const n = Math.min(...syms(baseCfg).map((s) => aligned[s]?.length ?? 0));
      const winBars = baseCfg.maxDays * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;

      console.log(
        `\n${"pingReliability".padEnd(18)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"p99".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(60));

      for (const prob of [1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.5]) {
        const cfg = { ...baseCfg, pingReliability: prob };
        let windows = 0,
          passes = 0,
          tl = 0,
          dl = 0;
        const passDays: number[] = [];
        for (let start = 0; start + winBars <= n; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of syms(baseCfg))
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
        console.log(
          `${String(prob).padEnd(18)} ${((passes / windows) * 100).toFixed(2).padStart(6)}% ${String(pctile(passDays, 0.5)).padStart(3)}d ${String(pctile(passDays, 0.25)).padStart(3)}d ${String(pctile(passDays, 0.75)).padStart(3)}d ${String(pctile(passDays, 0.9)).padStart(3)}d ${String(pctile(passDays, 0.99)).padStart(3)}d ${((tl / windows) * 100).toFixed(2).padStart(4)}%`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
