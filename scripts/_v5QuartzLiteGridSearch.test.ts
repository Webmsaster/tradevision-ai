/**
 * V5_QUARTZ_LITE 2-Parameter Grid Search.
 *
 * Goal: find +1.5pp pass-rate over baseline V5_QUARTZ_LITE
 *   (80.72% pass / 1d med / 18.52% TL — Round 19 numbers).
 *
 * Grid axes:
 *   1. dailyPeakTrailingStop.trailDistance ∈
 *        [0.012, 0.014, 0.016, 0.018, 0.020, 0.022, 0.025, 0.030]
 *   2. atrStop.stopMult ∈ [1.5, 1.8, 2.0, 2.2, 2.5, 3.0]
 *
 * 8 × 6 = 48 combos.
 *
 * Plus orthogonal axis (4 levels):
 *   peakDrawdownThrottle.factor ∈ [0.3, 0.4, 0.5, 0.7] with fromPeak=0.04
 *
 * Total trials: 52.  Estimated runtime ~30 minutes (5.71y / 30m / 368 windows).
 *
 * Output: pass-rate + median pass-day per trial, plus a TOP-N table sorted
 * by pass-rate then median.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m TF
const STEP_DAYS = 3;

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
  const stepBars = STEP_DAYS * BARS_PER_DAY;
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

describe("V5_QUARTZ_LITE 2-param grid search", { timeout: 90 * 60_000 }, () => {
  it("trailDistance × stopMult sweep + peakDrawdownThrottle.factor axis", async () => {
    const BASE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
    const symbols = syms(BASE);
    console.log(`Loading ${symbols.length} symbols (30m, max history)...`);
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 200,
        });
        data[s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    // Ensure FTMO-real caps + pause are in place for every trial
    const baseLite: FtmoDaytrade24hConfig = {
      ...BASE,
      liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
      pauseAtTargetReached: true,
    };

    // Establish baseline first for direct delta comparison.
    const baseline = evaluate(baseLite, data);
    if (!baseline) throw new Error("baseline evaluate failed");
    console.log(
      `\nBASELINE: pass=${(baseline.passRate * 100).toFixed(2)}% med=${baseline.med}d p90=${baseline.p90}d TL=${(baseline.tlPct * 100).toFixed(2)}% (windows=${baseline.windows})`,
    );
    const target = baseline.passRate + 0.015; // +1.5pp goal
    console.log(
      `Target pass-rate (baseline + 1.5pp): ${(target * 100).toFixed(2)}%`,
    );

    const TRAIL_GRID = [0.012, 0.014, 0.016, 0.018, 0.02, 0.022, 0.025, 0.03];
    const STOP_GRID = [1.5, 1.8, 2.0, 2.2, 2.5, 3.0];
    const THROTTLE_GRID = [0.3, 0.4, 0.5, 0.7];

    type Row = {
      name: string;
      pass: number;
      med: number;
      p25: number;
      p90: number;
      tl: number;
      delta: number;
    };
    const results: Row[] = [];

    console.log(
      `\n${"variant".padEnd(50)} ${"pass".padStart(7)} ${"Δpp".padStart(6)} ${"med".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
    );
    console.log("─".repeat(82));

    // === Phase 1 — 8×6 trail × stopMult grid (48 trials) ===
    for (const trail of TRAIL_GRID) {
      for (const sMult of STOP_GRID) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseLite,
          dailyPeakTrailingStop: { trailDistance: trail },
          atrStop: {
            ...(baseLite.atrStop ?? { period: 14 }),
            stopMult: sMult,
          },
        };
        const r = evaluate(cfg, data);
        if (!r) continue;
        const name = `trail=${trail.toFixed(3)} stopMult=${sMult.toFixed(1)}`;
        const delta = (r.passRate - baseline.passRate) * 100;
        const flag = delta >= 1.5 ? " 🏆 +1.5pp" : delta >= 0.5 ? " ✓" : "";
        console.log(
          `${name.padEnd(50)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${delta >= 0 ? "+" : ""}${delta.toFixed(2).padStart(5)} ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p90: r.p90,
          tl: r.tlPct,
          delta,
        });
      }
    }

    // === Phase 2 — peakDrawdownThrottle.factor (4 trials, fromPeak=0.04) ===
    console.log(
      `\n--- Phase 2: peakDrawdownThrottle.factor (fromPeak=0.04) ---`,
    );
    for (const factor of THROTTLE_GRID) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseLite,
        peakDrawdownThrottle: { fromPeak: 0.04, factor },
      };
      const r = evaluate(cfg, data);
      if (!r) continue;
      const name = `pdtThrottle factor=${factor.toFixed(2)} fromPeak=0.04`;
      const delta = (r.passRate - baseline.passRate) * 100;
      const flag = delta >= 1.5 ? " 🏆 +1.5pp" : delta >= 0.5 ? " ✓" : "";
      console.log(
        `${name.padEnd(50)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${delta >= 0 ? "+" : ""}${delta.toFixed(2).padStart(5)} ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
      );
      results.push({
        name,
        pass: r.passRate,
        med: r.med,
        p25: r.p25,
        p90: r.p90,
        tl: r.tlPct,
        delta,
      });
    }

    // === Summary: TOP-10 sorted by pass-rate then median ===
    results.sort((a, b) => b.pass - a.pass || a.med - b.med);
    console.log(`\n=== TOP-10 (sorted by pass-rate, then median) ===`);
    for (let i = 0; i < Math.min(10, results.length); i++) {
      const r = results[i];
      console.log(
        `${(i + 1).toString().padStart(2)}. ${r.name.padEnd(50)} pass=${(r.pass * 100).toFixed(2)}% (Δ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(2)}pp) med=${r.med}d p90=${r.p90}d TL=${(r.tl * 100).toFixed(2)}%`,
      );
    }

    const winners = results.filter((r) => r.delta >= 1.5);
    console.log(
      `\nWinners (+1.5pp or better): ${winners.length} / ${results.length} trials`,
    );
    if (winners.length > 0) {
      console.log(`Best winner: ${winners[0].name}`);
    } else {
      console.log(
        `No combo beat +1.5pp goal. Best delta: ${results[0]?.delta.toFixed(2)}pp (${results[0]?.name})`,
      );
    }

    expect(true).toBe(true);
  });
});
