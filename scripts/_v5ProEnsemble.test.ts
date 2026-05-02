/**
 * Phase G — Ensemble: V5_PRO + V12 + V261_2H_OPT.
 *
 * Run all 3 strategies in parallel on the same window. A "pass" is when
 * ANY of them passes. This is the upper bound of independent-run combos —
 * but in real life user could parallel-run 3 FTMO accounts.
 *
 * Goal: see how high the OR-pass-rate climbs to bracket the 55% target.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_PRO_ENSEMBLE_${STAMP}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, `${s}\n`);
}
function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "2h";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
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

interface RunResult {
  passed: boolean;
  passDay: number;
  reason: string;
}

function runOne(
  cfg: FtmoDaytrade24hConfig,
  slice: Record<string, Candle[]>,
): RunResult {
  const res = runFtmoDaytrade24h(slice, cfg);
  return { passed: res.passed, passDay: res.passDay ?? 99, reason: res.reason };
}

describe(
  "V5_PRO Ensemble (V5_PRO ∪ V5_HIWIN ∪ V5_PRIMEX)",
  { timeout: 4 * 3600_000 },
  () => {
    it("computes OR-passrate for parallel-run ensemble", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_PRO_ENSEMBLE START ${new Date().toISOString()}\n`,
      );

      const cfgs = [
        { name: "V5_PRO", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO },
        { name: "V5_HIWIN", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN },
        { name: "V5_PRIMEX", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX },
      ];

      const allSyms = [...new Set(cfgs.flatMap(({ cfg }) => syms(cfg)))].sort();
      log(`\nLoading ${allSyms.length} 2h symbols`);
      const data: Record<string, Candle[]> = {};
      for (const s of allSyms) {
        const raw = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data[s] = raw.filter((c) => c.isFinal);
        log(`  ${s.padEnd(10)} final=${data[s].length}`);
      }

      // Align using V5_PRO's symbols (largest set)
      const v5proSyms = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO);
      const alignedPro = alignCommon(data, v5proSyms);
      const n = Math.min(...v5proSyms.map((s) => alignedPro[s].length));
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;

      log(
        `\nWindows over ${(n / BARS_PER_DAY / 365).toFixed(2)}y, step 3d, win 30d`,
      );

      const ind: Record<
        string,
        {
          passes: number;
          passDays: number[];
          tl: number;
          dl: number;
          to: number;
        }
      > = {};
      for (const { name } of cfgs)
        ind[name] = { passes: 0, passDays: [], tl: 0, dl: 0, to: 0 };
      let ensemblePasses = 0;
      let ensemblePassDays: number[] = [];
      let totalWindows = 0;

      for (let start = 0; start + winBars <= n; start += stepBars) {
        totalWindows++;
        // Build slice per-cfg using its own symbol set, but anchored to alignedPro times
        const refTimes = alignedPro[v5proSyms[0]]
          .slice(start, start + winBars)
          .map((c) => c.openTime);
        const refTimeSet = new Set(refTimes);
        let anyPass = false;
        let bestPassDay = 99;

        for (const { name, cfg } of cfgs) {
          const cfgSyms = syms(cfg);
          const slice: Record<string, Candle[]> = {};
          for (const s of cfgSyms) {
            slice[s] = (data[s] ?? []).filter((c) =>
              refTimeSet.has(c.openTime),
            );
          }
          // Skip cfg if any of its symbols is empty for this window
          if (cfgSyms.some((s) => slice[s].length === 0)) continue;
          const ncfg = normalize(cfg);
          const r = runOne(ncfg, slice);
          if (r.passed) {
            ind[name].passes++;
            ind[name].passDays.push(r.passDay);
            if (r.passDay < bestPassDay) bestPassDay = r.passDay;
            anyPass = true;
          } else if (r.reason === "total_loss") ind[name].tl++;
          else if (r.reason === "daily_loss") ind[name].dl++;
          else if (r.reason === "time") ind[name].to++;
        }
        if (anyPass) {
          ensemblePasses++;
          ensemblePassDays.push(bestPassDay);
        }
      }

      log(`\nTotal windows: ${totalWindows}\n`);
      for (const { name } of cfgs) {
        const r = ind[name];
        r.passDays.sort((a, b) => a - b);
        const med = r.passDays[Math.floor(r.passDays.length * 0.5)] ?? 0;
        const p90 = r.passDays[Math.floor(r.passDays.length * 0.9)] ?? 0;
        log(
          `${name.padEnd(12)} solo: pass=${((r.passes / totalWindows) * 100).toFixed(2).padStart(6)}% (${r.passes}/${totalWindows}) med=${med}d p90=${p90}d TL=${r.tl} DL=${r.dl} TO=${r.to}`,
        );
      }
      ensemblePassDays.sort((a, b) => a - b);
      const ensMed =
        ensemblePassDays[Math.floor(ensemblePassDays.length * 0.5)] ?? 0;
      const ensP90 =
        ensemblePassDays[Math.floor(ensemblePassDays.length * 0.9)] ?? 0;
      log(
        `\n🤖 ENSEMBLE OR-pass: ${((ensemblePasses / totalWindows) * 100).toFixed(2)}% (${ensemblePasses}/${totalWindows}) med=${ensMed}d p90=${ensP90}d`,
      );
      log(
        `Hit 55%? ${ensemblePasses / totalWindows >= 0.55 && ensMed <= 4 ? "✅ YES" : "❌ NO"}`,
      );

      writeFileSync(
        `${LOG_DIR}/V5_PRO_ENSEMBLE_${STAMP}.json`,
        JSON.stringify(
          {
            totalWindows,
            individual: ind,
            ensemble: {
              passes: ensemblePasses,
              passRate: ensemblePasses / totalWindows,
              med: ensMed,
              p90: ensP90,
            },
          },
          null,
          2,
        ),
      );

      expect(ensemblePasses).toBeGreaterThan(0);
    });
  },
);
