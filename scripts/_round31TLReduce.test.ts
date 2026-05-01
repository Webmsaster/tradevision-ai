/**
 * Round 31 — TL-Reduktion Sweep gegen R28-Baseline.
 *
 * R28 baseline: 71.28% Pass / 27% TL on 5.71y / 665w / liveMode=true.
 *
 * R28 fail-mode is dominated by total_loss (27%), not daily_loss (~1%).
 * If we drop TL to ~20% without sacrificing pass-rate, we get +7pp.
 *
 * Sweep dimensions (all PURE config changes — no engine modifications):
 *   1. Asset-drop (9 variants): which single asset removal lifts the basket
 *   2. CPTS sweep (6 variants): challengePeakTrailingStop trailDistance
 *   3. DPT-tightness sweep (6 variants): dailyPeakTrailingStop trailDistance
 *   4. PTP fine-tune (8 variants): triggerPct × closeFraction grid
 *   5. Combined helpers (5 variants): pause-mode tweaks
 *
 * Total: ~34 variants. Win-criterion: Pass ≥ 72% AND TL ≤ 22%.
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

interface VariantResult {
  name: string;
  passes: number;
  total: number;
  passPct: number;
  tlPct: number;
  dlPct: number;
  medianPassDay: number;
}

describe(
  "Round 31 — TL-Reduction Sweep on R28",
  { timeout: 180 * 60_000 },
  () => {
    it("runs all variants and reports beating-R28 winners", async () => {
      type Variant = { name: string; cfg: FtmoDaytrade24hConfig };
      const variants: Variant[] = [];

      // Baseline
      variants.push({
        name: "R28_BASE",
        cfg: { ...BASE, liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 } },
      });

      // 1) Asset-drop sweep — drop each of 9 assets
      const r28Assets = BASE.assets.map((a) => a.symbol);
      for (const dropSym of r28Assets) {
        variants.push({
          name: `DROP_${dropSym.replace("-TREND", "")}`,
          cfg: {
            ...BASE,
            assets: BASE.assets.filter((a) => a.symbol !== dropSym),
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
          },
        });
      }

      // 2) CPTS sweep — challengePeakTrailingStop
      for (const td of [0.04, 0.045, 0.05, 0.055, 0.06, 0.07]) {
        variants.push({
          name: `CPTS_${td.toFixed(3)}`,
          cfg: {
            ...BASE,
            challengePeakTrailingStop: { trailDistance: td },
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
          },
        });
      }

      // 3) DPT-tightness sweep — current R28 = 0.012
      for (const td of [0.008, 0.01, 0.014, 0.016, 0.02]) {
        variants.push({
          name: `DPT_${td.toFixed(3)}`,
          cfg: {
            ...BASE,
            dailyPeakTrailingStop: { trailDistance: td },
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
          },
        });
      }

      // 4) PTP fine-tune (current R28 = trigger 0.025, fraction 0.6)
      for (const trig of [0.02, 0.03, 0.035]) {
        for (const frac of [0.5, 0.7]) {
          variants.push({
            name: `PTP_t${trig}_f${frac}`,
            cfg: {
              ...BASE,
              partialTakeProfit: { triggerPct: trig, closeFraction: frac },
              liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
            },
          });
        }
      }

      // 5) Combined: drop worst + CPTS — populated dynamically after asset-drop results
      // (skipped here to keep variants count manageable; combined sweep in R32)

      console.log(`Total variants: ${variants.length}`);

      // Load data once (use BASE assets — others are subsets)
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
      const ts0 = aligned[symbols[0]][0].openTime;
      const lastTs = aligned[symbols[0]][minBars - 1].openTime;
      console.log(
        `Data: ${minBars} bars / ${((lastTs - ts0) / (365 * 24 * 3600_000)).toFixed(2)}y`,
      );

      function runVariant(v: Variant): VariantResult {
        const passDays: number[] = [];
        let passes = 0;
        let tl = 0;
        let dl = 0;
        let total = 0;
        for (let start = 0; start + winBars <= minBars; start += stepBars) {
          const slice: Record<string, Candle[]> = {};
          const variantSymbols = syms(v.cfg);
          for (const s of variantSymbols)
            slice[s] = aligned[s]?.slice(start, start + winBars) ?? [];
          const res = runFtmoDaytrade24h(slice, v.cfg);
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
          name: v.name,
          passes,
          total,
          passPct: (passes / total) * 100,
          tlPct: (tl / total) * 100,
          dlPct: (dl / total) * 100,
          medianPassDay: passDays[Math.floor(passDays.length / 2)] ?? 0,
        };
      }

      const results: VariantResult[] = [];
      for (const v of variants) {
        const r = runVariant(v);
        results.push(r);
        console.log(
          `${r.name.padEnd(30)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% DL=${r.dlPct.toFixed(2)}% med=${r.medianPassDay}d`,
        );
      }

      // Summary: winners vs baseline
      const baseline = results.find((r) => r.name === "R28_BASE")!;
      console.log(
        `\n=== Baseline R28: pass=${baseline.passPct.toFixed(2)}% TL=${baseline.tlPct.toFixed(2)}% ===\n`,
      );

      const beatBase = results
        .filter((r) => r.name !== "R28_BASE")
        .filter(
          (r) =>
            r.passPct >= baseline.passPct - 0.5 && r.tlPct < baseline.tlPct - 1,
        )
        .sort((a, b) => b.passPct - a.passPct);
      console.log(
        `=== Variants beating R28 on TL (≥pass-0.5pp AND TL<baseline-1pp) ===`,
      );
      for (const r of beatBase) {
        console.log(
          `${r.name.padEnd(30)} Δpass=${(r.passPct - baseline.passPct).toFixed(2)}pp ΔTL=${(r.tlPct - baseline.tlPct).toFixed(2)}pp`,
        );
      }

      const lift = results
        .filter((r) => r.name !== "R28_BASE")
        .filter((r) => r.passPct >= 72.0 && r.tlPct <= 22.0)
        .sort((a, b) => b.passPct - a.passPct);
      console.log(`\n=== STRICT WINNERS (pass≥72% AND TL≤22%) ===`);
      for (const r of lift) {
        console.log(
          `${r.name.padEnd(30)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% (lift +${(r.passPct - baseline.passPct).toFixed(2)}pp)`,
        );
      }
      if (lift.length === 0) {
        console.log("(none — R28 ceiling holds on this dimension set)");
      }

      expect(results.length).toBeGreaterThan(20);
    });
  },
);
