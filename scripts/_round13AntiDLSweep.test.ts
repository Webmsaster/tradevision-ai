/**
 * Round 13 Anti-DL Sweep — push V5_NOVA Step 1 toward 70% pass-rate.
 *
 * Hebel: V5_NOVA NO-PAUSE has DL=53% fails. Anti-DL features:
 *   - intradayDailyLossThrottle: soft (-3%) cuts size 50%, hard (-4%) blocks
 *   - dailyPeakTrailingStop: drop trades after equity falls X% below daily peak
 *
 * Sweep dimensions (24 trials):
 *   - hardLossThreshold: 0.04, 0.045
 *   - softLossThreshold: 0.025, 0.03, 0.035
 *   - softFactor: 0.5, 0.3
 *   - dailyPeakTrailingStop: off, 0.025, 0.035
 *
 * Goal: NO-PAUSE pass-rate >= 50%, PAUSE pass-rate >= 70%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12; // 2h
const FTMO_LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

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
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) passes++;
    else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
  };
}

describe(
  "Round 13 Anti-DL Sweep — V5_NOVA Step 1",
  { timeout: 60 * 60_000 },
  () => {
    it("find params that push toward 70% pass-rate", async () => {
      const V5_NOVA = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA;
      const symbols = syms(V5_NOVA);
      console.log(`\nLoading ${symbols.length} symbols (2h)...`);
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
        } catch (e) {
          console.warn(`  skip ${s}: ${(e as Error).message}`);
        }
      }

      // Baseline (no Anti-DL)
      console.log("\n=== BASELINE (no Anti-DL) ===");
      const baseOrganic = evaluate(
        {
          ...V5_NOVA,
          liveCaps: FTMO_LIVE_CAPS,
          pauseAtTargetReached: false,
        },
        data,
      );
      const basePause = evaluate(
        {
          ...V5_NOVA,
          liveCaps: FTMO_LIVE_CAPS,
          pauseAtTargetReached: true,
        },
        data,
      );
      console.log(
        `baseline NO-PAUSE: pass=${((baseOrganic?.passRate ?? 0) * 100).toFixed(2)}% TL=${((baseOrganic?.tlPct ?? 0) * 100).toFixed(2)}% DL=${((baseOrganic?.dlPct ?? 0) * 100).toFixed(2)}%`,
      );
      console.log(
        `baseline PAUSE   : pass=${((basePause?.passRate ?? 0) * 100).toFixed(2)}% TL=${((basePause?.tlPct ?? 0) * 100).toFixed(2)}% DL=${((basePause?.dlPct ?? 0) * 100).toFixed(2)}%`,
      );

      // Sweep matrix
      const trials: Array<{
        name: string;
        cfg: FtmoDaytrade24hConfig;
      }> = [];

      const hardL = [0.04, 0.045];
      const softL = [0.025, 0.03, 0.035];
      const softF = [0.5, 0.3];
      const trail = [undefined, 0.025, 0.035];

      for (const h of hardL) {
        for (const s of softL) {
          if (s >= h) continue;
          for (const sf of softF) {
            for (const tr of trail) {
              const cfg: FtmoDaytrade24hConfig = {
                ...V5_NOVA,
                liveCaps: FTMO_LIVE_CAPS,
                pauseAtTargetReached: false,
                intradayDailyLossThrottle: {
                  hardLossThreshold: h,
                  softLossThreshold: s,
                  softFactor: sf,
                },
                ...(tr !== undefined
                  ? { dailyPeakTrailingStop: { trailDistance: tr } }
                  : {}),
              };
              trials.push({
                name: `h=${h} s=${s} sf=${sf} trail=${tr ?? "off"}`,
                cfg,
              });
            }
          }
        }
      }

      console.log(`\n${trials.length} trials...`);
      console.log(
        `\n${"variant".padEnd(40)} ${"NO-PAUSE".padStart(8)} ${"PAUSE".padStart(8)} ${"TL%".padStart(5)} ${"DL%".padStart(5)}`,
      );
      console.log("─".repeat(75));

      const results: Array<{
        name: string;
        organic: number;
        pause: number;
        dlPct: number;
        tlPct: number;
      }> = [];

      for (const { name, cfg } of trials) {
        const r = evaluate(cfg, data);
        const rPause = evaluate({ ...cfg, pauseAtTargetReached: true }, data);
        if (!r || !rPause) continue;
        const flag =
          rPause.passRate >= 0.7 ? " 🏆" : rPause.passRate >= 0.55 ? " ✓" : "";
        console.log(
          `${name.padEnd(40)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(rPause.passRate * 100).toFixed(2).padStart(7)}% ${(rPause.tlPct * 100).toFixed(2).padStart(4)}% ${(rPause.dlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          organic: r.passRate,
          pause: rPause.passRate,
          dlPct: rPause.dlPct,
          tlPct: rPause.tlPct,
        });
      }

      results.sort((a, b) => b.pause - a.pause);
      console.log("\n=== TOP-10 (sorted by PAUSE pass-rate) ===");
      for (let i = 0; i < Math.min(10, results.length); i++) {
        const r = results[i];
        console.log(
          `${String(i + 1).padEnd(3)} ${r.name.padEnd(40)} organic=${(r.organic * 100).toFixed(2).padStart(6)}% pause=${(r.pause * 100).toFixed(2).padStart(6)}% DL=${(r.dlPct * 100).toFixed(2).padStart(4)}% TL=${(r.tlPct * 100).toFixed(2).padStart(4)}%`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
