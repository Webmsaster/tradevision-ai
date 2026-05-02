/**
 * Round 21 — V5_QUARTZ_LITE (9 best assets) + timeBoost + LSC + rF combos.
 *
 * Agent recommendations:
 *   - timeBoost {afterDay:2, factor:2.0} = safest speed-lever
 *   - +lossStreakCooldown {afterLosses:2, cooldownBars:6} as safety net
 *   - +riskFrac 1.2 only with LSC active
 *
 * V5_QUARTZ_LITE = drop INJ/SAND/ARB/RUNE + drop AVAX (high-vol short-history).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;
const KEEP_ASSETS = [
  "BTC-TREND",
  "ETH-TREND",
  "BNB-TREND",
  "ADA-TREND",
  "LTC-TREND",
  "BCH-TREND",
  "ETC-TREND",
  "XRP-TREND",
  "AAVE-TREND",
];

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
  "Round 21 — V5_QUARTZ_LITE + timeBoost/LSC/rF combos",
  { timeout: 60 * 60_000 },
  () => {
    it("speed combos on filtered LITE pool", async () => {
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
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

      const baseLite: FtmoDaytrade24hConfig = {
        ...QZ,
        assets: QZ.assets.filter((a) => KEEP_ASSETS.includes(a.symbol)),
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.02 },
        pauseAtTargetReached: true,
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
      trials.push({ name: "BASELINE LITE 9-assets", cfg: baseLite });

      // timeBoost variants
      for (const f of [1.5, 2.0, 2.5]) {
        trials.push({
          name: `LITE + tBoost f=${f}`,
          cfg: {
            ...baseLite,
            timeBoost: { afterDay: 2, equityBelow: 0.05, factor: f },
          },
        });
      }

      // LSC variants
      for (const cd of [6, 12, 24]) {
        trials.push({
          name: `LITE + LSC cd=${cd}`,
          cfg: {
            ...baseLite,
            lossStreakCooldown: { afterLosses: 2, cooldownBars: cd },
          },
        });
      }

      // riskFrac scaling on LITE assets
      for (const rf of [1.2, 1.5]) {
        trials.push({
          name: `LITE + rF=${rf}`,
          cfg: {
            ...baseLite,
            assets: baseLite.assets.map((a) => ({
              ...a,
              riskFrac: a.riskFrac * rf,
            })),
          },
        });
      }

      // Combos
      trials.push({
        name: "🎯 LITE + tBoost f=2 + LSC cd=12",
        cfg: {
          ...baseLite,
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
          lossStreakCooldown: { afterLosses: 2, cooldownBars: 12 },
        },
      });
      trials.push({
        name: "🎯 LITE + tBoost f=2 + LSC cd=12 + rF=1.2",
        cfg: {
          ...baseLite,
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
          lossStreakCooldown: { afterLosses: 2, cooldownBars: 12 },
          assets: baseLite.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * 1.2,
          })),
        },
      });
      trials.push({
        name: "🎯 LITE + tBoost f=2.5 + LSC cd=12 + rF=1.2",
        cfg: {
          ...baseLite,
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.5 },
          lossStreakCooldown: { afterLosses: 2, cooldownBars: 12 },
          assets: baseLite.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * 1.2,
          })),
        },
      });
      trials.push({
        name: "🎯 ULTRA: LITE + tB-C f=1.5 always-on + LSC cd=12 + rF=1.5",
        cfg: {
          ...baseLite,
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
          lossStreakCooldown: { afterLosses: 2, cooldownBars: 12 },
          assets: baseLite.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * 1.5,
          })),
        },
      });

      console.log(
        `\n${"variant".padEnd(60)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
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
          r.med <= 4 && r.passRate >= 0.6
            ? " 🏆🏆🏆 GOAL!"
            : r.med <= 5 && r.passRate >= 0.6
              ? " 🏆"
              : r.med <= 6
                ? " ✓✓"
                : r.med <= 7
                  ? " ✓"
                  : "";
        console.log(
          `${name.padEnd(60)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
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

      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      const valid = results.filter((r) => r.pass >= 0.55);
      console.log("\n=== TOP-3 ===");
      for (let i = 0; i < Math.min(3, valid.length); i++) {
        const r = valid[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(60)} med=${r.med}d pass=${(r.pass * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
