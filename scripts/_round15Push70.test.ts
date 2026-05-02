/**
 * Round 15 — push toward 70% with Anti-DL + Anti-TL + tighter caps.
 *
 * Round 13 hit 62.69% pause / 55.57% organic plateau on V5_NOVA. TL=26.55%.
 * Anti-TL feature added: challengePeakTrailingStop. Combined with Anti-DL
 * (dailyPeakTrailingStop=0.015) this should crush TL fails and break the
 * 70% ceiling.
 *
 * Sweep: challengePeakTrailingStop ∈ [0.04, 0.05, 0.06, 0.07] × maxRiskFrac
 * tightening + maxStopPct tightening.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;

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

function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) passes++;
    else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
  };
}

describe(
  "Round 15 push to 70% — Anti-DL + Anti-TL combo",
  { timeout: 60 * 60_000 },
  () => {
    it("sweep challengePeakTrailingStop + tighter caps", async () => {
      const V5_NOVA = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA;
      const symbols = syms(V5_NOVA);
      console.log(`Loading ${symbols.length} symbols (2h)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 100000,
            maxPages: 120,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      // Base: V5_NOVA + Anti-DL (best Round-13 config)
      const baseAntiDL: FtmoDaytrade24hConfig = {
        ...V5_NOVA,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.015 },
        pauseAtTargetReached: true,
      };

      console.log(
        `\n${"variant".padEnd(50)} ${"NO-PAUSE".padStart(8)} ${"PAUSE".padStart(7)} ${"TL%".padStart(5)} ${"DL%".padStart(5)}`,
      );
      console.log("─".repeat(85));

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];

      // Baseline
      trials.push({ name: "BASELINE Anti-DL only", cfg: baseAntiDL });

      // Pure Anti-TL trail variants (no other change)
      for (const td of [0.04, 0.05, 0.06, 0.07, 0.08]) {
        trials.push({
          name: `+ challengeTrail=${td}`,
          cfg: {
            ...baseAntiDL,
            challengePeakTrailingStop: { trailDistance: td },
          },
        });
      }

      // Tighter liveCaps maxRiskFrac
      for (const rf of [0.3, 0.25, 0.2]) {
        trials.push({
          name: `liveCaps maxRiskFrac=${rf}`,
          cfg: {
            ...baseAntiDL,
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: rf },
          },
        });
      }

      // Tighter maxStopPct
      for (const sp of [0.04, 0.03]) {
        trials.push({
          name: `liveCaps maxStopPct=${sp}`,
          cfg: {
            ...baseAntiDL,
            liveCaps: { maxStopPct: sp, maxRiskFrac: 0.4 },
          },
        });
      }

      // Combos: Anti-TL + tighter caps
      const combos: Array<{ tt: number; rf: number; sp: number }> = [
        { tt: 0.05, rf: 0.4, sp: 0.05 },
        { tt: 0.06, rf: 0.4, sp: 0.05 },
        { tt: 0.05, rf: 0.3, sp: 0.05 },
        { tt: 0.06, rf: 0.3, sp: 0.05 },
        { tt: 0.05, rf: 0.4, sp: 0.04 },
        { tt: 0.06, rf: 0.4, sp: 0.04 },
        { tt: 0.05, rf: 0.3, sp: 0.04 },
        { tt: 0.06, rf: 0.3, sp: 0.04 },
        { tt: 0.07, rf: 0.3, sp: 0.04 },
        { tt: 0.05, rf: 0.25, sp: 0.04 },
      ];
      for (const { tt, rf, sp } of combos) {
        trials.push({
          name: `COMBO trail=${tt} rf=${rf} sp=${sp}`,
          cfg: {
            ...baseAntiDL,
            liveCaps: { maxStopPct: sp, maxRiskFrac: rf },
            challengePeakTrailingStop: { trailDistance: tt },
          },
        });
      }

      const results: Array<{
        name: string;
        organic: number;
        pause: number;
        tl: number;
        dl: number;
      }> = [];
      for (const { name, cfg } of trials) {
        const rOrg = evaluate({ ...cfg, pauseAtTargetReached: false }, data);
        const rPause = evaluate(cfg, data);
        if (!rOrg || !rPause) continue;
        const flag =
          rPause.passRate >= 0.7
            ? " 🏆🏆🏆"
            : rPause.passRate >= 0.65
              ? " 🏆"
              : rPause.passRate >= 0.6
                ? " ✓"
                : "";
        console.log(
          `${name.padEnd(50)} ${(rOrg.passRate * 100).toFixed(2).padStart(7)}% ${(rPause.passRate * 100).toFixed(2).padStart(6)}% ${(rPause.tlPct * 100).toFixed(2).padStart(4)}% ${(rPause.dlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          organic: rOrg.passRate,
          pause: rPause.passRate,
          tl: rPause.tlPct,
          dl: rPause.dlPct,
        });
      }

      results.sort((a, b) => b.pause - a.pause);
      console.log("\n=== TOP-5 ===");
      for (let i = 0; i < Math.min(5, results.length); i++) {
        const r = results[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(50)} organic=${(r.organic * 100).toFixed(2).padStart(6)}% pause=${(r.pause * 100).toFixed(2).padStart(6)}% TL=${(r.tl * 100).toFixed(2)}% DL=${(r.dl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
