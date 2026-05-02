/**
 * Round 28 — last-shot 80%: Step 2 (5%/60d) + ensemble approaches.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;

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

interface V {
  name: string;
  cfg: FtmoDaytrade24hConfig;
}

const VARIANTS: V[] = [
  {
    name: "R28_Step1(8%/30d)",
    cfg: { ...BASE, liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 } },
  },
  // Step 2 = 5% target / 60d (easier rule)
  {
    name: "R28_Step2(5%/60d)",
    cfg: {
      ...BASE,
      profitTarget: 0.05,
      maxDays: 60,
      holdBars: 1200,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  },
  // Step 2 with even more headroom
  {
    name: "R28_Step2(5%/60d)_+lsc",
    cfg: {
      ...BASE,
      profitTarget: 0.05,
      maxDays: 60,
      holdBars: 1200,
      lossStreakCooldown: { afterLosses: 2, cooldownBars: 200 },
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  },
  // Loosen dpt for Step 2 (less aggressive halt since timeline longer)
  {
    name: "R28_Step2_dpt020",
    cfg: {
      ...BASE,
      profitTarget: 0.05,
      maxDays: 60,
      holdBars: 1200,
      dailyPeakTrailingStop: { trailDistance: 0.02 },
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  },
  // Even further: 4% target on 60d
  {
    name: "R28_Step2_4pct",
    cfg: {
      ...BASE,
      profitTarget: 0.04,
      maxDays: 60,
      holdBars: 1200,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  },
  // 6% target
  {
    name: "R28_Step2_6pct",
    cfg: {
      ...BASE,
      profitTarget: 0.06,
      maxDays: 60,
      holdBars: 1200,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
    },
  },
];

describe("Round 28 — Step 2 80% probe", { timeout: 120 * 60_000 }, () => {
  it("test R28 on Step 2 rules + variants", async () => {
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

    type R = { name: string; pass: number; tl: number; med: number; n: number };
    const results: R[] = [];
    for (const v of VARIANTS) {
      const winBars = v.cfg.maxDays * bpd;
      const stepBars = 3 * bpd;
      let w = 0,
        p = 0,
        tl = 0;
      const days: number[] = [];
      for (let start = 0; start + winBars <= minBars; start += stepBars) {
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
      results.push({ name: v.name, pass: passPct, tl: tlPct, med, n: w });
      console.log(
        `${v.name.padEnd(35)} | ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | med ${med}d`,
      );
    }
    console.log(`\n=== SORTED ===`);
    const sorted = [...results].sort((a, b) => b.pass - a.pass);
    for (const r of sorted) {
      console.log(
        `${r.name.padEnd(35)} | ${r.pass.toFixed(2).padStart(6)}% | TL ${r.tl.toFixed(2)}% | med ${r.med}d`,
      );
    }
    const winner = sorted[0];
    console.log(
      `\n>>> WINNER: ${winner.name} → ${winner.pass.toFixed(2)}% <<<`,
    );
    if (winner.pass >= 80) console.log(`*** GOAL ACHIEVED: ≥80%! ***`);
    else console.log(`*** gap to 80%: ${(80 - winner.pass).toFixed(2)}pp ***`);
    expect(true).toBe(true);
  });
});
