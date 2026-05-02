/**
 * Round 20 — V5_QUARTZ on 15m timeframe.
 * Goal: median 4d (per Agent recommendation Variant A).
 *
 * V5_QUARTZ atrStop p=56 m=2 on 30m = 2-4% stops (under 5% liveCap).
 * Scale to 15m: p=224 m=2 (same time-window of 56h ATR).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 96; // 15m

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
  "Round 20 — V5_QUARTZ on 15m timeframe",
  { timeout: 60 * 60_000 },
  () => {
    it("Variants A/B/C from agent + ULTIMATE combos", async () => {
      const QZ = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const symbols = syms(QZ);
      console.log(`Loading ${symbols.length} symbols (15m)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "15m",
            targetCount: 200000,
            maxPages: 240,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      const baseAntiDL: FtmoDaytrade24hConfig = {
        ...QZ,
        timeframe: "15m",
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.02 },
        pauseAtTargetReached: true,
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];
      trials.push({
        name: "BASELINE V5_QUARTZ on 15m (no scaling)",
        cfg: baseAntiDL,
      });

      // Variant A — Conservative (linear 4× of 30m)
      trials.push({
        name: "Variant A — atrStop p=224 m=2.0 / chand p=224 m=2.0 / hb=240",
        cfg: {
          ...baseAntiDL,
          holdBars: 240,
          atrStop: { period: 224, stopMult: 2.0 },
          chandelierExit: { period: 224, mult: 2.0, minMoveR: 0.5 },
        },
      });

      // Variant B — Tighter ATR
      trials.push({
        name: "Variant B — atrStop p=56 m=2.5 / chand p=56 m=2.5 / hb=240",
        cfg: {
          ...baseAntiDL,
          holdBars: 240,
          atrStop: { period: 56, stopMult: 2.5 },
          chandelierExit: { period: 56, mult: 2.5, minMoveR: 0.5 },
        },
      });

      // Variant C — Hybrid + timeBoost
      trials.push({
        name: "Variant C — atrStop p=112 m=2 / hb=480 / tBoost f=2",
        cfg: {
          ...baseAntiDL,
          holdBars: 480,
          atrStop: { period: 112, stopMult: 2.0 },
          chandelierExit: { period: 112, mult: 2.0, minMoveR: 0.5 },
          timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
        },
      });

      // Ultimate combos
      trials.push({
        name: "🎯 Variant A + drop INJ+SAND+ARB+RUNE",
        cfg: {
          ...baseAntiDL,
          holdBars: 240,
          atrStop: { period: 224, stopMult: 2.0 },
          chandelierExit: { period: 224, mult: 2.0, minMoveR: 0.5 },
          assets: baseAntiDL.assets.filter(
            (a) =>
              !["INJ-TREND", "SAND-TREND", "ARB-TREND", "RUNE-TREND"].includes(
                a.symbol,
              ),
          ),
        },
      });
      trials.push({
        name: "🎯 Variant A + tBoost f=1.5",
        cfg: {
          ...baseAntiDL,
          holdBars: 240,
          atrStop: { period: 224, stopMult: 2.0 },
          chandelierExit: { period: 224, mult: 2.0, minMoveR: 0.5 },
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
        },
      });
      trials.push({
        name: "🎯 Variant A + drop AAVE+INJ + tBoost f=1.5",
        cfg: {
          ...baseAntiDL,
          holdBars: 240,
          atrStop: { period: 224, stopMult: 2.0 },
          chandelierExit: { period: 224, mult: 2.0, minMoveR: 0.5 },
          assets: baseAntiDL.assets.filter(
            (a) => !["AAVE-TREND", "INJ-TREND"].includes(a.symbol),
          ),
          timeBoost: { afterDay: 0, equityBelow: 0.08, factor: 1.5 },
        },
      });

      console.log(
        `\n${"variant".padEnd(60)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(95));

      const results: Array<{
        name: string;
        pass: number;
        med: number;
        p25: number;
        p75: number;
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
              : r.med <= 6 && r.passRate >= 0.55
                ? " ✓✓"
                : r.med <= 7
                  ? " ✓"
                  : "";
        console.log(
          `${name.padEnd(60)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p75).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p75: r.p75,
          p90: r.p90,
          tl: r.tlPct,
        });
      }

      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      console.log("\n=== TOP-3 ===");
      const valid = results.filter((r) => r.pass >= 0.55);
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
