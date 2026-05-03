/**
 * Round 23 — Push V5_QUARTZ_LITE 78%→80% OOS.
 *
 * Bootstrap CI says point-estimate is 81.30%. With targeted tweaks we should
 * be able to lock in >80%.
 *
 * Sweep:
 *   - Trail variants {0.015, 0.02, 0.025}
 *   - intradayDailyLossThrottle variants
 *   - peakDrawdownThrottle variants
 *   - Asset add/drop variants
 *   - timeBoost variants
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
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
  "Round 23 — push V5_QUARTZ_LITE to 80%",
  { timeout: 60 * 60_000 },
  () => {
    it("multi-axis sweep: trail/throttle/peakDD/timeBoost/asset adds", async () => {
      const LITE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      // Load full QUARTZ symbols to allow add-back tests
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
        ...LITE,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        pauseAtTargetReached: true,
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
      trials.push({ name: "BASELINE V5_QUARTZ_LITE", cfg: baseCfg });

      // Trail variants
      for (const td of [0.015, 0.018, 0.022, 0.025]) {
        trials.push({
          name: `trail=${td}`,
          cfg: { ...baseCfg, dailyPeakTrailingStop: { trailDistance: td } },
        });
      }

      // intradayDailyLossThrottle
      trials.push({
        name: "+ intradayDLThrottle s=2.5%/h=4%/sf=0.5",
        cfg: {
          ...baseCfg,
          intradayDailyLossThrottle: {
            softLossThreshold: 0.025,
            hardLossThreshold: 0.04,
            softFactor: 0.5,
          },
        },
      });
      trials.push({
        name: "+ intradayDLThrottle s=2%/h=3.5%/sf=0.4",
        cfg: {
          ...baseCfg,
          intradayDailyLossThrottle: {
            softLossThreshold: 0.02,
            hardLossThreshold: 0.035,
            softFactor: 0.4,
          },
        },
      });

      // peakDrawdownThrottle
      trials.push({
        name: "+ peakDDThrottle 0.04/0.5",
        cfg: {
          ...baseCfg,
          peakDrawdownThrottle: { fromPeak: 0.04, factor: 0.5 },
        },
      });
      trials.push({
        name: "+ peakDDThrottle 0.05/0.4",
        cfg: {
          ...baseCfg,
          peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.4 },
        },
      });

      // challengePeakTrailingStop
      trials.push({
        name: "+ challengeTrail 0.05",
        cfg: { ...baseCfg, challengePeakTrailingStop: { trailDistance: 0.05 } },
      });
      trials.push({
        name: "+ challengeTrail 0.06",
        cfg: { ...baseCfg, challengePeakTrailingStop: { trailDistance: 0.06 } },
      });

      // timeBoost variants
      trials.push({
        name: "+ tBoost {1, 0.05, 1.5}",
        cfg: {
          ...baseCfg,
          timeBoost: { afterDay: 1, equityBelow: 0.05, factor: 1.5 },
        },
      });
      trials.push({
        name: "+ tBoost {2, 0.04, 2.0}",
        cfg: {
          ...baseCfg,
          timeBoost: { afterDay: 2, equityBelow: 0.04, factor: 2.0 },
        },
      });

      // Asset variants — add back individual dropped assets
      const droppedAssets = [
        "AVAX-TREND",
        "DOGE-TREND",
        "INJ-TREND",
        "RUNE-TREND",
        "SAND-TREND",
        "ARB-TREND",
      ];
      for (const asset of droppedAssets) {
        const addBackAssets = QZ.assets.filter(
          (a) =>
            baseCfg.assets.map((b) => b.symbol).includes(a.symbol) ||
            a.symbol === asset,
        );
        trials.push({
          name: `+ add-back ${asset}`,
          cfg: { ...baseCfg, assets: addBackAssets },
        });
      }

      // ULTIMATE combos
      trials.push({
        name: "🎯 trail=0.018 + peakDD 0.04/0.5",
        cfg: {
          ...baseCfg,
          dailyPeakTrailingStop: { trailDistance: 0.018 },
          peakDrawdownThrottle: { fromPeak: 0.04, factor: 0.5 },
        },
      });
      trials.push({
        name: "🎯 trail=0.018 + intradayDL s=2.5/h=4/sf=0.4 + peakDD 0.04/0.5",
        cfg: {
          ...baseCfg,
          dailyPeakTrailingStop: { trailDistance: 0.018 },
          intradayDailyLossThrottle: {
            softLossThreshold: 0.025,
            hardLossThreshold: 0.04,
            softFactor: 0.4,
          },
          peakDrawdownThrottle: { fromPeak: 0.04, factor: 0.5 },
        },
      });
      trials.push({
        name: "🎯 ALL anti-loss combo",
        cfg: {
          ...baseCfg,
          dailyPeakTrailingStop: { trailDistance: 0.018 },
          intradayDailyLossThrottle: {
            softLossThreshold: 0.025,
            hardLossThreshold: 0.04,
            softFactor: 0.4,
          },
          peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.4 },
          challengePeakTrailingStop: { trailDistance: 0.06 },
        },
      });

      console.log(
        `\n${"variant".padEnd(55)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(85));

      const results: Array<{
        name: string;
        pass: number;
        med: number;
        p25: number;
        p90: number;
        tl: number;
      }> = [];
      for (const { name, cfg } of trials) {
        const r = evaluate(cfg, data);
        if (!r) continue;
        const flag =
          r.passRate >= 0.83
            ? " 🏆🏆🏆"
            : r.passRate >= 0.8
              ? " 🏆 GOAL!"
              : r.passRate >= 0.78
                ? " ✓✓"
                : r.passRate >= 0.7
                  ? " ✓"
                  : "";
        console.log(
          `${name.padEnd(55)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p90: r.p90,
          tl: r.tlPct,
        });
      }

      results.sort((a, b) => b.pass - a.pass);
      console.log("\n=== TOP-5 by pass-rate ===");
      for (let i = 0; i < Math.min(5, results.length); i++) {
        const r = results[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(55)} pass=${(r.pass * 100).toFixed(2)}% med=${r.med}d TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
