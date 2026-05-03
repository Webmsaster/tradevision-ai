/**
 * Round 35 — Push beyond R28_V3 (81.20%).
 *
 * Hypothesen:
 *   A) Even tighter factor: 0.10, 0.15 on fromPeak 0.020-0.040
 *   B) Very tight fromPeak: 0.010-0.018 (catch profit-give-back earlier)
 *   C) Very loose fromPeak: 0.05, 0.06, 0.07 with factor 0.20
 *   D) Per-asset basket reduction on new baseline
 *   E) Combined R28_V3 + tighter dpt
 *
 * Win-criterion: Pass ≥ 82.0% AND TL ≤ 17%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V3,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_R28_V3;

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

describe("Round 35 — Push beyond R28_V3", { timeout: 180 * 60_000 }, () => {
  it("aggressive pDD + asset-drop + dpt combos", async () => {
    const liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
    const variants: { name: string; cfg: FtmoDaytrade24hConfig }[] = [];

    variants.push({ name: "BASE_R28V3", cfg: { ...BASE, liveCaps } });

    // A) Even tighter factor (0.10, 0.15)
    for (const fp of [0.02, 0.025, 0.03, 0.035, 0.04]) {
      for (const fac of [0.1, 0.15]) {
        variants.push({
          name: `pDDtight_${fp.toFixed(3)}_${fac.toFixed(2)}`,
          cfg: {
            ...BASE,
            peakDrawdownThrottle: { fromPeak: fp, factor: fac },
            liveCaps,
          },
        });
      }
    }

    // B) Very tight fromPeak
    for (const fp of [0.01, 0.012, 0.015, 0.018]) {
      for (const fac of [0.2, 0.25]) {
        variants.push({
          name: `pDDvtight_${fp.toFixed(3)}_${fac.toFixed(2)}`,
          cfg: {
            ...BASE,
            peakDrawdownThrottle: { fromPeak: fp, factor: fac },
            liveCaps,
          },
        });
      }
    }

    // C) Loose fromPeak with factor 0.20
    for (const fp of [0.05, 0.06, 0.08]) {
      variants.push({
        name: `pDDloose_${fp.toFixed(3)}_0.20`,
        cfg: {
          ...BASE,
          peakDrawdownThrottle: { fromPeak: fp, factor: 0.2 },
          liveCaps,
        },
      });
    }

    // D) Asset drops on new baseline (R28_V3)
    for (const dropSym of BASE.assets.map((a) => a.symbol)) {
      variants.push({
        name: `DROP_${dropSym.replace("-TREND", "")}`,
        cfg: {
          ...BASE,
          assets: BASE.assets.filter((a) => a.symbol !== dropSym),
          liveCaps,
        },
      });
    }

    // E) DPT-tightness combos (current R28_V3 dpt = 0.012)
    for (const td of [0.008, 0.01, 0.014, 0.016]) {
      variants.push({
        name: `DPT_${td.toFixed(3)}`,
        cfg: {
          ...BASE,
          dailyPeakTrailingStop: { trailDistance: td },
          liveCaps,
        },
      });
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

    const baseRes = results.find((r) => r.name === "BASE_R28V3")!;
    console.log(
      `\n=== Baseline R28_V3: pass=${baseRes.passPct.toFixed(2)}% TL=${baseRes.tlPct.toFixed(2)}% ===\n`,
    );

    const winners = results
      .filter((r) => r.name !== "BASE_R28V3")
      .filter((r) => r.passPct >= 82.0 && r.tlPct <= 17.0)
      .sort((a, b) => b.passPct - a.passPct);
    console.log(`=== STRICT WINNERS (pass≥82% AND TL≤17%) ===`);
    if (winners.length === 0) {
      console.log("(none — possibly hitting structural ceiling)");
    } else {
      for (const r of winners) {
        console.log(
          `${r.name.padEnd(35)} pass=${r.passPct.toFixed(2)}% TL=${r.tlPct.toFixed(2)}% (lift +${(r.passPct - baseRes.passPct).toFixed(2)}pp)`,
        );
      }
    }

    const top = results
      .filter((r) => r.name !== "BASE_R28V3")
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
});
