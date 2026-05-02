/**
 * Round 28 — V12-style feature boost on V5_QUARTZ_LITE under liveMode=true.
 *
 * Round 28 ceiling: V5_QUARTZ_LITE+dpt015 hits 69.17% (TL 29.47%, med 4d).
 * Goal: knack 70%. Try grafting V12-family features that are drift-friendly:
 *   - partialTakeProfit {triggerPct: 0.02, closeFraction: 0.3}
 *   - holdBars: 1200
 *   - lossStreakCooldown {afterLosses: 2, cooldownBars: 200}
 *   - timeBoost {afterDay: 2, equityBelow: 0.05, factor: 2.0}
 *   - htfTrendFilter {lookbackBars: 200, threshold: 0.08, apply: "short"}
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

function v(name: string, overrides: Partial<FtmoDaytrade24hConfig>): Variant {
  return {
    name,
    cfg: {
      ...BASE,
      dailyPeakTrailingStop: { trailDistance: 0.015 },
      liveMode: true,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      ...overrides,
    } as FtmoDaytrade24hConfig,
  };
}

const VARIANTS: Variant[] = [
  v("BASE_dpt015", {}),
  v("+ptp", { partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 } }),
  v("+ptp30", { partialTakeProfit: { triggerPct: 0.03, closeFraction: 0.3 } }),
  v("+ptp25_50", {
    partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.5 },
  }),
  v("+lsc", { lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 } }),
  v("+lsc100", { lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 } }),
  v("+lsc3_300", { lossStreakCooldown: { afterLosses: 3, cooldownBars: 300 } }),
  v("+timeBoost", {
    timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
  }),
  v("+timeBoost4d", {
    timeBoost: { afterDay: 4, equityBelow: 0.05, factor: 1.5 },
  }),
  v("+holdBars1200", { holdBars: 1200 }),
  v("+holdBars600", { holdBars: 600 }),
  v("+htfTF", {
    htfTrendFilter: { lookbackBars: 200, threshold: 0.08, apply: "short" },
  }),
  v("+htfTF_both", {
    htfTrendFilter: { lookbackBars: 200, threshold: 0.08, apply: "both" },
  }),
  // combos
  v("+ptp+lsc", {
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
    lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
  }),
  v("+ptp+lsc+timeBoost", {
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
    lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
    timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
  }),
  v("V12_FULL_GRAFT", {
    partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
    lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
    timeBoost: { afterDay: 2, equityBelow: 0.05, factor: 2.0 },
    holdBars: 1200,
    htfTrendFilter: { lookbackBars: 200, threshold: 0.08, apply: "short" },
  }),
];

describe(
  "Round 28 — V12 boost sweep liveMode=true",
  { timeout: 120 * 60_000 },
  () => {
    it("graft V12 features onto V5_QUARTZ_LITE for 70%+", async () => {
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

      type R = { name: string; passPct: number; tlPct: number; med: number };
      const results: R[] = [];

      for (const variant of VARIANTS) {
        let w = 0,
          p = 0,
          tl = 0;
        const days: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, variant.cfg);
          w++;
          if (res.passed) {
            p++;
            if (res.passDay) days.push(res.passDay);
          } else if (res.reason === "total_loss") tl++;
        }
        days.sort((a, b) => a - b);
        const passPct = (p / w) * 100;
        const tlPct = (tl / w) * 100;
        const med = days[Math.floor(days.length / 2)] ?? 0;
        results.push({ name: variant.name, passPct, tlPct, med });
        console.log(
          `${variant.name.padEnd(24)}| ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | med ${med}d`,
        );
      }

      console.log(`\n=== SORTED BY PASS-RATE ===`);
      const sorted = [...results].sort((a, b) => b.passPct - a.passPct);
      for (const r of sorted) {
        console.log(
          `${r.name.padEnd(24)}| ${r.passPct.toFixed(2).padStart(6)}% | TL ${r.tlPct.toFixed(2).padStart(6)}% | med ${r.med}d`,
        );
      }
      const winner = sorted[0];
      console.log(
        `\n>>> WINNER: ${winner.name} → ${winner.passPct.toFixed(2)}% (TL ${winner.tlPct.toFixed(2)}%, med ${winner.med}d) <<<`,
      );
      if (winner.passPct >= 70)
        console.log(
          `*** GOAL ACHIEVED: ≥70% liveMode=true single-account! ***`,
        );
      else
        console.log(
          `*** NOT YET: gap = ${(70 - winner.passPct).toFixed(2)}pp ***`,
        );
      expect(true).toBe(true);
    });
  },
);
