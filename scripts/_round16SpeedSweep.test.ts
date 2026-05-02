/**
 * Round 16 Speed Sweep — V5_NOVA tweaks to compress median 12d → 5-7d.
 *
 * Forensik-Erkenntnisse:
 *   - H1 Trade-Frequency: hour-filter 10/24 → only 41% of bars eligible
 *   - H3 Chandelier early-exit: p=56 trail kills winners at +3-4% before 7% TP
 *   - trailingStop too aggressive: activate=2.5% / trail=0.5% locks too early
 *   - momentumRanking topN 7/8 filters one asset unnecessarily
 *
 * Sweep: 16 trial combos with hour-expansion, chandelier-relax, trail-relax.
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
  const stepBars = 3 * BARS_PER_DAY;
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

describe(
  "Round 16 Speed Sweep — V5_NOVA tweaks to compress median",
  { timeout: 60 * 60_000 },
  () => {
    it("hours/chandelier/trail tweaks", async () => {
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
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        dailyPeakTrailingStop: { trailDistance: 0.015 },
        pauseAtTargetReached: true,
      };

      const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [];

      // Baseline
      trials.push({ name: "BASELINE V5_NOVA + Anti-DL", cfg: baseAntiDL });

      // H1: Hour-filter expansion
      // Original: [1,2,4,9,10,13,14,16,17,19] = 10/24 hours
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      // V5_NOVA's hours were tuned for high-quality. Expand carefully.
      const hourVariants: Record<string, number[]> = {
        "hours 10/24 (orig)": [1, 2, 4, 9, 10, 13, 14, 16, 17, 19],
        "hours 16/24 (drop bad8)": allHours.filter(
          (h) => ![3, 5, 7, 11, 15, 21, 22, 23].includes(h),
        ),
        "hours 18/24 (drop bad6)": allHours.filter(
          (h) => ![5, 7, 11, 15, 22, 23].includes(h),
        ),
        "hours 21/24 (drop bad3)": allHours.filter(
          (h) => ![7, 11, 23].includes(h),
        ),
        "hours 24/24 (all)": allHours,
      };
      for (const [label, hrs] of Object.entries(hourVariants)) {
        if (label === "hours 10/24 (orig)") continue;
        trials.push({
          name: label,
          cfg: { ...baseAntiDL, allowedHoursUtc: hrs },
        });
      }

      // H3: Chandelier relaxation
      const chand = baseAntiDL.chandelierExit;
      if (chand) {
        for (const [p, m] of [
          [24, 2.0],
          [24, 2.5],
          [12, 2.5],
          [12, 3.0],
        ]) {
          trials.push({
            name: `chand p=${p} m=${m}`,
            cfg: {
              ...baseAntiDL,
              chandelierExit: { period: p as number, mult: m as number },
            },
          });
        }
        // Disable chandelier
        trials.push({
          name: "no chandelier",
          cfg: { ...baseAntiDL, chandelierExit: undefined },
        });
      }

      // trailingStop relax
      const ts = baseAntiDL.trailingStop;
      if (ts) {
        trials.push({
          name: "trailingStop relax (act=4%, trail=1.5%)",
          cfg: {
            ...baseAntiDL,
            trailingStop: { activatePct: 0.04, trailPct: 0.015 },
          },
        });
        trials.push({
          name: "no trailingStop",
          cfg: { ...baseAntiDL, trailingStop: undefined },
        });
      }

      // momentumRanking topN expand
      const mr = baseAntiDL.momentumRanking;
      if (mr) {
        trials.push({
          name: "momentumRanking topN=8 (all)",
          cfg: { ...baseAntiDL, momentumRanking: { ...mr, topN: 8 } },
        });
        trials.push({
          name: "no momentumRanking",
          cfg: { ...baseAntiDL, momentumRanking: undefined },
        });
      }

      // COMBOS — top tweaks together
      trials.push({
        name: "COMBO hours18 + chand24/2.5 + tsRelax",
        cfg: {
          ...baseAntiDL,
          allowedHoursUtc: hourVariants["hours 18/24 (drop bad6)"],
          chandelierExit: { period: 24, mult: 2.5 },
          trailingStop: { activatePct: 0.04, trailPct: 0.015 },
        },
      });
      trials.push({
        name: "COMBO hours24 + no chand + no ts",
        cfg: {
          ...baseAntiDL,
          allowedHoursUtc: allHours,
          chandelierExit: undefined,
          trailingStop: undefined,
        },
      });
      trials.push({
        name: "COMBO MAX hours24 + no chand + no ts + topN8",
        cfg: {
          ...baseAntiDL,
          allowedHoursUtc: allHours,
          chandelierExit: undefined,
          trailingStop: undefined,
          momentumRanking: mr ? { ...mr, topN: 8 } : undefined,
        },
      });

      console.log(
        `\n${"variant".padEnd(50)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p25".padStart(4)} ${"p75".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
      );
      console.log("─".repeat(85));

      const results: Array<{
        name: string;
        pass: number;
        med: number;
        p25: number;
        p75: number;
        p90: number;
        tl: number;
      }> = [];

      for (const { name, cfg } of trials) {
        const r = evaluate(cfg, data);
        if (!r) continue;
        const flag =
          r.med <= 7 && r.passRate >= 0.6
            ? " 🏆🏆🏆"
            : r.med <= 9 && r.passRate >= 0.6
              ? " 🏆"
              : r.med <= 10
                ? " ✓"
                : "";
        console.log(
          `${name.padEnd(50)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p25).padStart(3)}d ${String(r.p75).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          pass: r.passRate,
          med: r.med,
          p25: r.p25,
          p75: r.p75,
          p90: r.p90,
          tl: r.tlPct,
        });
      }

      // Sort by median asc, pass desc
      results.sort((a, b) => a.med - b.med || b.pass - a.pass);
      console.log("\n=== TOP-5 by lowest median (with pass>=55%) ===");
      const valid = results.filter((r) => r.pass >= 0.55);
      for (let i = 0; i < Math.min(5, valid.length); i++) {
        const r = valid[i];
        console.log(
          `${i + 1}. ${r.name.padEnd(50)} med=${r.med}d pass=${(r.pass * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}%`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
