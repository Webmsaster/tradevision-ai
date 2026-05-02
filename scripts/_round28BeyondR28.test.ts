/**
 * Round 28 — beyond R28: try OTHER configs/baskets under liveMode=true.
 *
 * R28 plateau at ~72%. Test if other configs (V261, V12, V5_JADE etc) have
 * higher honest-mode ceilings. Also test ensemble approach.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

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

function withLiveMode(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    liveMode: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  } as FtmoDaytrade24hConfig;
}

// Apply R28-style tweaks (dpt 0.012 + ptp 0.025/0.6) to other configs
function withR28Tweaks(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    dailyPeakTrailingStop: { trailDistance: 0.012 },
    partialTakeProfit: { triggerPct: 0.025, closeFraction: 0.6 },
    liveMode: true,
    liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
  } as FtmoDaytrade24hConfig;
}

interface Variant {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf: string;
  bpd: number;
}

const VARIANTS: Variant[] = [
  // R28 family
  {
    name: "R28_BASE",
    cfg: withLiveMode(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28),
    tf: "30m",
    bpd: 48,
  },
  // Larger baskets with R28-tweaks applied
  {
    name: "QLITE_PLUS+R28tweaks(10assets)",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS),
    tf: "30m",
    bpd: 48,
  },
  {
    name: "AGATE+R28tweaks",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE),
    tf: "30m",
    bpd: 48,
  },
  {
    name: "SAPPHIR+R28tweaks(18a)",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR),
    tf: "30m",
    bpd: 48,
  },
  {
    name: "PEARL+R28tweaks(19a)",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL),
    tf: "30m",
    bpd: 48,
  },
  {
    name: "JADE+R28tweaks(20a)",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE),
    tf: "30m",
    bpd: 48,
  },
  // V5_NOVA family with R28 tweaks
  {
    name: "NOVA_liveMode",
    cfg: withLiveMode(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA),
    tf: "2h",
    bpd: 12,
  },
  {
    name: "NOVA+R28tweaks",
    cfg: withR28Tweaks(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA),
    tf: "2h",
    bpd: 12,
  },
];

describe(
  "Round 28 — beyond R28 ceiling probe",
  { timeout: 180 * 60_000 },
  () => {
    it("test alternative configs/baskets under liveMode=true", async () => {
      const allSyms = new Set<string>();
      for (const v of VARIANTS) for (const s of syms(v.cfg)) allSyms.add(s);
      console.log(`Loading ${allSyms.size} symbols across all variants:`);

      type R = {
        name: string;
        pass: number;
        tl: number;
        med: number;
        n: number;
      };
      const results: R[] = [];

      for (const v of VARIANTS) {
        const symbols = syms(v.cfg);
        const data: Record<string, Candle[]> = {};
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: v.tf as any,
              targetCount: 100000,
              maxPages: 120,
            });
            data[s] = r.filter((c) => c.isFinal);
          } catch {}
        }
        const aligned = alignCommon(data, symbols);
        const minBars = Math.min(
          ...symbols.map((s) => aligned[s]?.length ?? 0),
        );
        const winBars = v.cfg.maxDays * v.bpd;
        const stepBars = 3 * v.bpd;

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
          `${v.name.padEnd(35)} | ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(6)}% | med ${med}d | tf ${v.tf}`,
        );
      }

      console.log(`\n\n=== SORTED ===`);
      const sorted = [...results].sort((a, b) => b.pass - a.pass);
      for (const r of sorted) {
        console.log(
          `${r.name.padEnd(35)} | ${r.pass.toFixed(2).padStart(6)}% | TL ${r.tl.toFixed(2)}% | med ${r.med}d | n=${r.n}`,
        );
      }
      const winner = sorted[0];
      console.log(
        `\n>>> WINNER: ${winner.name} → ${winner.pass.toFixed(2)}% <<<`,
      );
      if (winner.pass >= 80)
        console.log(
          `*** GOAL ACHIEVED: ≥80% liveMode=true single-account! ***`,
        );
      else if (winner.pass >= 75)
        console.log(
          `*** PROGRESS: ${winner.pass.toFixed(2)}% (gap to 80%: ${(80 - winner.pass).toFixed(2)}pp) ***`,
        );
      else
        console.log(
          `*** STILL stuck near R28 ceiling. gap to 80%: ${(80 - winner.pass).toFixed(2)}pp ***`,
        );
      expect(true).toBe(true);
    });
  },
);
