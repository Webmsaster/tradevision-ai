/**
 * Round 34 — Fine-Tune around R28_V2 (75.64% Pass / 24% TL).
 *
 * R33 winner: PTP_t0.02_f0.7 + pDD{0.03, 0.3} = 75.64% / 24% TL.
 *
 * Hypothesen:
 *   A) Tighter pDD grid: fromPeak [0.020-0.040 in 0.005 steps]
 *      × factor [0.20, 0.25, 0.30, 0.35, 0.40]  → 25 cells
 *   B) Two-tier pDD via drawdownShield (different mechanism, deeper threshold)
 *   C) Combined: pDD + drawdownShield (catches both shallow and deep DD)
 *   D) Verify: PTP triggerPct sweep on pDD baseline
 *
 * Win-criterion: Pass ≥ 76.5% (=R28_V2 + 1pp) AND TL ≤ 23%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V2;

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

interface VR {
  name: string;
  passPct: number;
  tlPct: number;
  dlPct: number;
  med: number;
}

describe(
  "Round 34 — Fine-tune around R28_V2",
  { timeout: 180 * 60_000 },
  () => {
    it("pDD-grid + drawdownShield + PTP variants", async () => {
      const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
      const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [];

      variants.push({ name: "BASE_R28V2", cfg: { ...BASE, liveCaps } });

      // A) Fine-grid pDD around (0.03, 0.3)
      for (const fp of [0.02, 0.025, 0.03, 0.035, 0.04]) {
        for (const fac of [0.2, 0.25, 0.3, 0.35, 0.4]) {
          if (fp === 0.03 && fac === 0.3) continue; // skip duplicate of base
          variants.push({
            name: `pDD_${fp.toFixed(3)}_${fac.toFixed(2)}`,
            cfg: {
              ...BASE,
              peakDrawdownThrottle: { fromPeak: fp, factor: fac },
              liveCaps,
            },
          });
        }
      }

      // B) drawdownShield (absolute threshold below start)
      for (const be of [-0.02, -0.03, -0.04, -0.05]) {
        for (const fac of [0.3, 0.5]) {
          variants.push({
            name: `dS_${be.toFixed(2)}_${fac.toFixed(2)}`,
            cfg: {
              ...BASE,
              drawdownShield: { belowEquity: be, factor: fac },
              liveCaps,
            },
          });
        }
      }

      // C) Combined: pDD + drawdownShield
      for (const dsBe of [-0.03, -0.05]) {
        for (const dsFac of [0.3, 0.5]) {
          variants.push({
            name: `pDD+dS_${dsBe.toFixed(2)}_${dsFac.toFixed(2)}`,
            cfg: {
              ...BASE,
              drawdownShield: { belowEquity: dsBe, factor: dsFac },
              liveCaps,
            },
          });
        }
      }

      // D) PTP variants on R28_V2 base (verify 0.02/0.7 still optimal with pDD)
      for (const trig of [0.015, 0.018, 0.022, 0.025]) {
        for (const frac of [0.6, 0.7, 0.8]) {
          if (trig === 0.02 && frac === 0.7) continue;
          variants.push({
            name: `PTP_t${trig}_f${frac}`,
            cfg: {
              ...BASE,
              partialTakeProfit: { triggerPct: trig, closeFraction: frac },
              liveCaps,
            },
          });
        }
      }

      console.log(`Total variants: ${variants.length}`);

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

      function runVariant(cfg: FtmoDaytrade24hConfig): VR {
        const passDays: number[] = [];
        let passes = 0;
        let tl = 0;
        let dl = 0;
        let total = 0;
        const variantSymbols = syms(cfg);
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          for (const s of variantSymbols)
            slice[s] = aligned[s]?.slice(start, start + winBars) ?? [];
          const res = runFtmoDaytrade24h(slice, cfg);
          total++;
          if (res.passed) {
            passes++;
            if (res.passDay) passDays.push(res.passDay);
          }
          if (res.reason?.includes("total_loss")) tl++;
          if (res.reason?.includes("daily_loss")) dl++;
        }
        passDays.sort((a, b) => a - b);
        return {
          name: "",
          passPct: (passes / total) * 100,
          tlPct: (tl / total) * 100,
          dlPct: (dl / total) * 100,
          med: passDays[Math.floor(passDays.length / 2)] ?? 0,
        };
      }

      const results: VR[] = [];
      for (const v of variants) {
        const r = { ...runVariant(v.cfg), name: v.name };
        results.push(r);
        console.log(
          `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% DL=${r.dlPct.toFixed(2)}% med=${r.med}d`,
        );
      }

      const baseRes = results.find((r) => r.name === "BASE_R28V2")!;
      console.log(
        `\n=== Baseline R28_V2: pass=${baseRes.passPct.toFixed(2)}% TL=${baseRes.tlPct.toFixed(2)}% ===\n`,
      );

      const winners = results
        .filter((r) => r.name !== "BASE_R28V2")
        .filter((r) => r.passPct >= 76.5 && r.tlPct <= 23.0)
        .sort((a, b) => b.passPct - a.passPct);
      console.log(`=== STRICT WINNERS (pass≥76.5% AND TL≤23%) ===`);
      if (winners.length === 0) {
        console.log("(none)");
      } else {
        for (const r of winners) {
          console.log(
            `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% (lift +${(r.passPct - baseRes.passPct).toFixed(2)}pp / TL Δ${(r.tlPct - baseRes.tlPct).toFixed(2)}pp)`,
          );
        }
      }

      const top = results
        .filter((r) => r.name !== "BASE_R28V2")
        .sort((a, b) => b.passPct - a.passPct)
        .slice(0, 8);
      console.log(`\n=== TOP 8 by Pass-Rate ===`);
      for (const r of top) {
        console.log(
          `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% Δpass=${(r.passPct - baseRes.passPct).toFixed(2)}pp`,
        );
      }

      expect(results.length).toBeGreaterThan(20);
    });
  },
);
