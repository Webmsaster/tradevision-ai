/**
 * Round 14 — TL Reduction Sweep on V5_NOVA + Anti-DL.
 *
 * Round 13 Anti-DL pushed V5_NOVA from 46% → 62% pause but TL jumped from
 * 15% → 24%. To reach 70%+ we need TL reduction. Hebel:
 *
 *   - Per-asset riskFrac (V5_NOVA mostly 1.0 — try 0.7-0.85)
 *   - chandelierExit mult (currently 56/1.5 — try wider 56/2.0, 56/2.5)
 *   - Tighter peakDrawdownThrottle (catches profit-give-back)
 *
 * Variant on top of best Round-13 config: anti-DL with trail=0.025.
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
const FTMO_LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

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
  "Round 14 TL-Reduction sweep — push V5_NOVA toward 70%",
  { timeout: 60 * 60_000 },
  () => {
    it("variants on riskFrac + chandelier", async () => {
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

      const baseAntiDL: FtmoDaytrade24hConfig = {
        ...V5_NOVA,
        liveCaps: FTMO_LIVE_CAPS,
        pauseAtTargetReached: true,
        dailyPeakTrailingStop: { trailDistance: 0.025 },
      };

      console.log(
        `\n${"variant".padEnd(48)} ${"NO-PAUSE".padStart(8)} ${"PAUSE".padStart(7)} ${"TL%".padStart(5)} ${"DL%".padStart(5)}`,
      );
      console.log("─".repeat(80));

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];

      // Baseline reproduction
      trials.push({ name: "BASELINE Anti-DL trail=0.025", cfg: baseAntiDL });

      // riskFrac scaling on all assets
      for (const scale of [0.85, 0.7, 0.5]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...baseAntiDL,
          assets: baseAntiDL.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * scale,
          })),
        };
        trials.push({ name: `riskFrac × ${scale}`, cfg });
      }

      // chandelier wider mults
      const chand = baseAntiDL.chandelierExit;
      if (chand) {
        for (const m of [2.0, 2.5, 3.0]) {
          trials.push({
            name: `chand p=${chand.period} m=${m}`,
            cfg: { ...baseAntiDL, chandelierExit: { ...chand, mult: m } },
          });
        }
      }

      // peakDrawdownThrottle variants
      for (const fp of [0.04, 0.05, 0.06]) {
        for (const f of [0.5, 0.3]) {
          trials.push({
            name: `peakDDThrottle fromPeak=${fp} factor=${f}`,
            cfg: {
              ...baseAntiDL,
              peakDrawdownThrottle: { fromPeak: fp, factor: f },
            },
          });
        }
      }

      // tighter trail (more conservative)
      for (const td of [0.015, 0.02, 0.03]) {
        trials.push({
          name: `trail=${td}`,
          cfg: { ...baseAntiDL, dailyPeakTrailingStop: { trailDistance: td } },
        });
      }

      // Combo: riskFrac × 0.85 + peakDDThrottle + tighter trail
      trials.push({
        name: "COMBO rf0.85 + peakDD0.05/0.5 + trail0.02",
        cfg: {
          ...baseAntiDL,
          assets: baseAntiDL.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * 0.85,
          })),
          peakDrawdownThrottle: { fromPeak: 0.05, factor: 0.5 },
          dailyPeakTrailingStop: { trailDistance: 0.02 },
        },
      });
      trials.push({
        name: "COMBO rf0.7 + peakDD0.04/0.3 + trail0.025",
        cfg: {
          ...baseAntiDL,
          assets: baseAntiDL.assets.map((a) => ({
            ...a,
            riskFrac: a.riskFrac * 0.7,
          })),
          peakDrawdownThrottle: { fromPeak: 0.04, factor: 0.3 },
          dailyPeakTrailingStop: { trailDistance: 0.025 },
        },
      });

      const results: Array<{
        name: string;
        organic: number;
        pause: number;
        tl: number;
        dl: number;
      }> = [];
      for (const { name, cfg } of trials) {
        const rOrganic = evaluate(
          { ...cfg, pauseAtTargetReached: false },
          data,
        );
        const rPause = evaluate(cfg, data);
        if (!rOrganic || !rPause) continue;
        const flag =
          rPause.passRate >= 0.7
            ? " 🏆"
            : rPause.passRate >= 0.65
              ? " ✓✓"
              : rPause.passRate >= 0.6
                ? " ✓"
                : "";
        console.log(
          `${name.padEnd(48)} ${(rOrganic.passRate * 100).toFixed(2).padStart(7)}% ${(rPause.passRate * 100).toFixed(2).padStart(6)}% ${(rPause.tlPct * 100).toFixed(2).padStart(4)}% ${(rPause.dlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          organic: rOrganic.passRate,
          pause: rPause.passRate,
          tl: rPause.tlPct,
          dl: rPause.dlPct,
        });
      }

      results.sort((a, b) => b.pause - a.pause);
      console.log("\n=== TOP-10 (by PAUSE pass-rate) ===");
      for (let i = 0; i < Math.min(10, results.length); i++) {
        const r = results[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(48)} organic=${(r.organic * 100).toFixed(2).padStart(6)}% pause=${(r.pause * 100).toFixed(2).padStart(6)}% TL=${(r.tl * 100).toFixed(2).padStart(4)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
