/**
 * Round 28 — R28 features on different timeframes.
 *
 * Test if R28-tweaks (dpt 0.012 + ptp 0.022/0.6 + liveMode) on TF other
 * than 30m has higher honest ceiling toward 80%.
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

interface TFTest {
  tf: "15m" | "30m" | "1h" | "2h" | "4h";
  bpd: number;
}
const TFS: TFTest[] = [
  { tf: "15m", bpd: 96 },
  { tf: "30m", bpd: 48 },
  { tf: "1h", bpd: 24 },
  { tf: "2h", bpd: 12 },
  { tf: "4h", bpd: 6 },
];

describe("Round 28 — R28 across timeframes", { timeout: 180 * 60_000 }, () => {
  it("test R28 features on 15m/30m/1h/2h/4h", async () => {
    type R = {
      tfStep: string;
      pass: number;
      tl: number;
      med: number;
      n: number;
    };
    const results: R[] = [];

    for (const tfTest of TFS) {
      for (const step of ["S1", "S2"] as const) {
        const cfg: FtmoDaytrade24hConfig = {
          ...BASE,
          timeframe: tfTest.tf,
          dailyPeakTrailingStop: { trailDistance: 0.012 },
          partialTakeProfit: { triggerPct: 0.022, closeFraction: 0.6 },
          liveMode: true,
          liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
          ...(step === "S2"
            ? { profitTarget: 0.05, maxDays: 60, holdBars: 1200 }
            : {}),
        } as FtmoDaytrade24hConfig;
        const symbols = syms(cfg);
        const data: Record<string, Candle[]> = {};
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: tfTest.tf,
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
        const winBars = cfg.maxDays * tfTest.bpd;
        const stepBars = 3 * tfTest.bpd;
        let w = 0,
          p = 0,
          tl = 0;
        const days: number[] = [];
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of symbols)
            slice[s] = aligned[s].slice(start, start + winBars);
          const res = runFtmoDaytrade24h(slice, cfg);
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
        const tfStep = `${tfTest.tf.padStart(3)} ${step}`;
        results.push({ tfStep, pass: passPct, tl: tlPct, med, n: w });
        console.log(
          `${tfStep} | ${p}/${w} = ${passPct.toFixed(2).padStart(6)}% | TL ${tlPct.toFixed(2).padStart(5)}% | med ${med}d`,
        );
      }
    }
    console.log(`\n=== SORTED ===`);
    const sorted = [...results].sort((a, b) => b.pass - a.pass);
    for (const r of sorted)
      console.log(
        `${r.tfStep} | ${r.pass.toFixed(2).padStart(6)}% | TL ${r.tl.toFixed(2)}% | med ${r.med}d | n=${r.n}`,
      );
    const winner = sorted[0];
    console.log(
      `\n>>> WINNER: ${winner.tfStep} → ${winner.pass.toFixed(2)}% <<<`,
    );
    if (winner.pass >= 80) console.log(`*** GOAL ACHIEVED: ≥80%! ***`);
    else console.log(`*** gap to 80%: ${(80 - winner.pass).toFixed(2)}pp ***`);
    expect(true).toBe(true);
  });
});
