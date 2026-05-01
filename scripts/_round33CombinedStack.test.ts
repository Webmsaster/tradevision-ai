/**
 * Round 33 — Combined-Stack: R31 winner (PTP_t0.03_f0.7) + neue Helpers.
 *
 * R31 lesson:
 *   - PTP_t0.03_f0.7 lifted pass +0.9pp aber TL ~unchanged (27%)
 *   - CPTS killed pass at all useful levels (40-57%)
 *
 * Hypothesen R33:
 *   A) Sehr lockere CPTS (0.08-0.15) lässt TL etwas runter ohne Pass zu killen
 *   B) peakDrawdownThrottle (RISK-scale-down statt Block) — neue Defensive
 *   C) intradayDailyLossThrottle (soft daily-loss circuit-breaker)
 *   D) Combined: PTP_t0.03_f0.7 + best-of-each
 *
 * Win-criterion: Pass ≥ 72.5% AND TL ≤ 24%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28;
// R32-validated winner: PTP_t0.02_f0.7 — TRAIN/TEST drift -3.83pp, 72.18% pass.
const PTP_WIN: FtmoDaytrade24hConfig = {
  ...BASE,
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.7 },
};

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
  "Round 33 — Combined Stack on PTP-winner",
  { timeout: 180 * 60_000 },
  () => {
    it("loose CPTS + peakDrawdownThrottle + intradayThrottle combos", async () => {
      const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
      const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [];

      variants.push({ name: "BASE_R28", cfg: { ...BASE, liveCaps } });
      variants.push({ name: "PTP_WIN", cfg: { ...PTP_WIN, liveCaps } });

      // A) Lockere CPTS auf PTP_WIN
      for (const td of [0.08, 0.1, 0.12, 0.15]) {
        variants.push({
          name: `PTP+CPTS_${td}`,
          cfg: {
            ...PTP_WIN,
            challengePeakTrailingStop: { trailDistance: td },
            liveCaps,
          },
        });
      }

      // B) peakDrawdownThrottle on PTP_WIN
      for (const fp of [0.03, 0.05, 0.07]) {
        for (const fac of [0.3, 0.5, 0.7]) {
          variants.push({
            name: `PTP+pDD_${fp}_${fac}`,
            cfg: {
              ...PTP_WIN,
              peakDrawdownThrottle: { fromPeak: fp, factor: fac },
              liveCaps,
            },
          });
        }
      }

      // C) intradayDailyLossThrottle on PTP_WIN
      for (const sl of [0.02, 0.025, 0.03]) {
        for (const sf of [0.3, 0.5]) {
          variants.push({
            name: `PTP+idlt_${sl}_${sf}`,
            cfg: {
              ...PTP_WIN,
              intradayDailyLossThrottle: {
                softLossThreshold: sl,
                hardLossThreshold: 0.04,
                softFactor: sf,
              },
              liveCaps,
            },
          });
        }
      }

      // D) Combined best-guesses
      variants.push({
        name: "PTP+CPTS_0.10+pDD_0.05_0.5",
        cfg: {
          ...PTP_WIN,
          challengePeakTrailingStop: { trailDistance: 0.1 },
          peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.5 },
          liveCaps,
        },
      });
      variants.push({
        name: "PTP+pDD_0.05_0.5+idlt_0.025_0.5",
        cfg: {
          ...PTP_WIN,
          peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.5 },
          intradayDailyLossThrottle: {
            softLossThreshold: 0.025,
            hardLossThreshold: 0.04,
            softFactor: 0.5,
          },
          liveCaps,
        },
      });

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

      // Strict winners
      const baseR28 = results.find((r) => r.name === "BASE_R28")!;
      console.log(
        `\n=== Baseline R28: pass=${baseR28.passPct.toFixed(2)}% TL=${baseR28.tlPct.toFixed(2)}% ===\n`,
      );

      const winners = results
        .filter((r) => r.name !== "BASE_R28")
        .filter((r) => r.passPct >= 72.5 && r.tlPct <= 24.0)
        .sort((a, b) => b.passPct - a.passPct);
      console.log(`=== STRICT WINNERS (pass≥72.5% AND TL≤24%) ===`);
      if (winners.length === 0) {
        console.log("(none)");
      } else {
        for (const r of winners) {
          console.log(
            `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% (lift +${(r.passPct - baseR28.passPct).toFixed(2)}pp / TL Δ${(r.tlPct - baseR28.tlPct).toFixed(2)}pp)`,
          );
        }
      }

      // Soft winners: any improvement on Pareto front
      const soft = results
        .filter((r) => r.name !== "BASE_R28")
        .filter(
          (r) =>
            r.passPct >= baseR28.passPct + 0.5 || r.tlPct <= baseR28.tlPct - 1,
        )
        .sort((a, b) => b.passPct - b.tlPct - (a.passPct - a.tlPct));
      console.log(`\n=== SOFT WINNERS (pass+0.5pp OR TL-1pp) ===`);
      for (const r of soft.slice(0, 8)) {
        console.log(
          `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% Δpass=${(r.passPct - baseR28.passPct).toFixed(2)}pp ΔTL=${(r.tlPct - baseR28.tlPct).toFixed(2)}pp`,
        );
      }

      expect(results.length).toBeGreaterThan(10);
    });
  },
);
