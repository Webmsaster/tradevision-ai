/**
 * Round 28 — Step 2 Plus2: stack additional features on best Step-2 config.
 *
 * Best Step-2 so far: dpt0.012 + ptp0.022/0.6 = 77.86%.
 * Try: + lsc, + atrStop variants, + hb1200, + chandelier tighter, + cpts.
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

// Best Step-2 base from prior sweep
function makeStep2(
  overrides: Partial<FtmoDaytrade24hConfig>,
): FtmoDaytrade24hConfig {
  return {
    ...BASE,
    profitTarget: 0.05,
    maxDays: 60,
    holdBars: 1200,
    dailyPeakTrailingStop: { trailDistance: 0.012 },
    partialTakeProfit: { triggerPct: 0.022, closeFraction: 0.6 },
    liveMode: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    ...overrides,
  } as FtmoDaytrade24hConfig;
}

interface V {
  name: string;
  cfg: FtmoDaytrade24hConfig;
}
const VARIANTS: V[] = [
  { name: "S2_BASE", cfg: makeStep2({}) },
  {
    name: "S2+lsc2_100",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 100 },
    }),
  },
  {
    name: "S2+lsc2_200",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
    }),
  },
  {
    name: "S2+lsc3_300",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 3, cooldownBars: 300 },
    }),
  },
  {
    name: "S2+atrP28m2",
    cfg: makeStep2({ atrStop: { period: 28, stopMult: 2 } }),
  },
  {
    name: "S2+atrP56m2",
    cfg: makeStep2({ atrStop: { period: 56, stopMult: 2 } }),
  },
  {
    name: "S2+atrP84m1.5",
    cfg: makeStep2({ atrStop: { period: 84, stopMult: 1.5 } }),
  },
  {
    name: "S2+chandP56m1.5",
    cfg: makeStep2({ chandelierExit: { period: 56, mult: 1.5 } }),
  },
  {
    name: "S2+chandP28m2.5",
    cfg: makeStep2({ chandelierExit: { period: 28, mult: 2.5 } }),
  },
  {
    name: "S2+cpts0.07",
    cfg: makeStep2({ challengePeakTrailingStop: { trailDistance: 0.07 } }),
  },
  {
    name: "S2+cpts0.06",
    cfg: makeStep2({ challengePeakTrailingStop: { trailDistance: 0.06 } }),
  },
  {
    name: "S2+timeBoost",
    cfg: makeStep2({
      timeBoost: { afterDay: 30, equityBelow: 0.04, factor: 1.5 },
    }),
  },
  // Combos
  {
    name: "S2+lsc2_200+chand56m1.5",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
      chandelierExit: { period: 56, mult: 1.5 },
    }),
  },
  {
    name: "S2+lsc2_200+atrP56m2",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
      atrStop: { period: 56, stopMult: 2 },
    }),
  },
  {
    name: "S2+lsc2_200+cpts0.06",
    cfg: makeStep2({
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
      challengePeakTrailingStop: { trailDistance: 0.06 },
    }),
  },
];

describe("Round 28 — Step 2 Plus2", { timeout: 120 * 60_000 }, () => {
  it("stack features for 80%", async () => {
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
    const winBars = 60 * bpd;
    const stepBars = 3 * bpd;
    const wStarts: number[] = [];
    for (let s = 0; s + winBars <= minBars; s += stepBars) wStarts.push(s);

    type R = { name: string; pass: number; tl: number; med: number };
    const results: R[] = [];
    for (const v of VARIANTS) {
      let w = 0,
        p = 0,
        tl = 0;
      const days: number[] = [];
      for (const start of wStarts) {
        const slice: Record<string, Candle[]> = {};
        for (const s of symbols)
          slice[s] = aligned[s].slice(start, start + winBars);
        const res = runFtmoDaytrade24h(slice, v.cfg);
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
      results.push({ name: v.name, pass: passPct, tl: tlPct, med });
      console.log(
        `${v.name.padEnd(35)} | ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | med ${med}d`,
      );
    }
    console.log(`\n=== SORTED ===`);
    const sorted = [...results].sort((a, b) => b.pass - a.pass);
    for (const r of sorted)
      console.log(
        `${r.name.padEnd(35)} | ${r.pass.toFixed(2).padStart(6)}% | TL ${r.tl.toFixed(2)}% | med ${r.med}d`,
      );
    const winner = sorted[0];
    console.log(
      `\n>>> WINNER: ${winner.name} → ${winner.pass.toFixed(2)}% <<<`,
    );
    if (winner.pass >= 80) console.log(`*** 80% CRACKED on Step 2! ***`);
    else console.log(`*** gap: ${(80 - winner.pass).toFixed(2)}pp ***`);
    expect(true).toBe(true);
  });
});
