/**
 * Round 28 — liveMode multi-config sweep.
 *
 * Runs 8 candidate FTMO configs under BOTH liveMode=false (legacy
 * exit-time sort, lookahead-favoring) AND liveMode=true (entry-time sort,
 * matches a real live bot) on the maximum aligned data window.
 *
 * Goal: identify which configs HOLD their pass-rate when the lookahead-
 * inflation is removed. Configs with low state-dependence should be more
 * stable. Any config ≥75% under liveMode=true is a viable single-account
 * live-deploy candidate — that's our true 70%+ ceiling.
 *
 * Run:
 *   node ./node_modules/vitest/vitest.mjs run \
 *     scripts/_liveModeMultiConfigSweep.test.ts \
 *     --reporter=basic --testTimeout=2400000
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_V245,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { pick, computePassDay } from "./_passDayUtils";

const TARGET_COUNT = 6000;
const MAX_PAGES = 60;
const CHALLENGE_DAYS = 30;
const STEP_DAYS = 3;

interface SweepRow {
  config: string;
  tf: string;
  passFalse: number;
  passTrue: number;
  drift: number;
  tlTrue: number;
  dlTrue: number;
  medTrue: number;
  windows: number;
}

const TF_HOURS: Record<string, number> = {
  "15m": 0.25,
  "30m": 0.5,
  "1h": 1,
  "2h": 2,
  "4h": 4,
};

/** Collect every USDT symbol the config references (assets + cross filters). */
function configSymbols(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

/** Intersect all symbols on common openTime, returning aligned slices. */
function alignCommon(
  data: Record<string, Candle[]>,
  symbols: string[],
): Record<string, Candle[]> {
  const sets = symbols.map((s) => new Set(data[s].map((c) => c.openTime)));
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const out: Record<string, Candle[]> = {};
  for (const s of symbols) out[s] = data[s].filter((c) => cs.has(c.openTime));
  return out;
}

async function loadAllSymbols(
  symbols: string[],
  tf: string,
): Promise<Record<string, Candle[]>> {
  const data: Record<string, Candle[]> = {};
  for (const s of symbols) {
    try {
      const r = await loadBinanceHistory({
        symbol: s,
        timeframe: tf as any,
        targetCount: TARGET_COUNT,
        maxPages: MAX_PAGES,
      });
      data[s] = r.filter((c) => c.isFinal);
    } catch (e) {
      console.warn(`  load failed for ${s} @ ${tf}: ${(e as Error).message}`);
    }
  }
  return data;
}

function walkForward(
  cfg: FtmoDaytrade24hConfig,
  aligned: Record<string, Candle[]>,
  tfHours: number,
) {
  const barsPerDay = Math.round(24 / tfHours);
  const winBars = CHALLENGE_DAYS * barsPerDay;
  const stepBars = STEP_DAYS * barsPerDay;
  const symbols = Object.keys(aligned);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const results: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= n; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const sym of symbols) slice[sym] = aligned[sym].slice(s, s + winBars);
    results.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = results.filter((r) => r.passed).length;
  const tl = results.filter((r) => r.reason === "total_loss").length;
  const dl = results.filter((r) => r.reason === "daily_loss").length;
  const days: number[] = [];
  for (const r of results) if (r.passed) days.push(computePassDay(r));
  days.sort((a, b) => a - b);
  return {
    windows: results.length,
    passes,
    passRate: results.length ? passes / results.length : 0,
    tl,
    dl,
    med: pick(days, 0.5) || 0,
  };
}

interface ConfigEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  tf: string;
}

const CONFIGS: ConfigEntry[] = [
  // 30m basket (V5 family + V12)
  {
    name: "V5_QUARTZ_LITE",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
    tf: "30m",
  },
  {
    name: "V5_QUARTZ_LITE_PLUS",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE_PLUS,
    tf: "30m",
  },
  {
    name: "V5_NOVA",
    cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
    tf: "30m",
  },
  { name: "V12_30M_OPT", cfg: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, tf: "30m" },
  {
    name: "V12_TURBO_30M_OPT",
    cfg: FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
    tf: "30m",
  },
  // 4h
  { name: "V245", cfg: FTMO_DAYTRADE_24H_CONFIG_V245, tf: "4h" },
  // 2h
  { name: "V261_2H_OPT", cfg: FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT, tf: "2h" },
  // 15m
  { name: "V16_15M_OPT", cfg: FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT, tf: "15m" },
];

describe(
  "Round 28 liveMode multi-config sweep",
  { timeout: 60 * 60_000 },
  () => {
    it("compares 8 configs under liveMode=false vs liveMode=true", async () => {
      // Group configs by TF so we load each (symbol, tf) once.
      const byTf = new Map<string, ConfigEntry[]>();
      for (const c of CONFIGS) {
        if (!byTf.has(c.tf)) byTf.set(c.tf, []);
        byTf.get(c.tf)!.push(c);
      }

      // Per-TF data cache: { tf -> { symbol -> candles } }
      const tfData = new Map<string, Record<string, Candle[]>>();

      for (const [tf, group] of byTf) {
        const allSyms = new Set<string>();
        for (const g of group)
          for (const s of configSymbols(g.cfg)) allSyms.add(s);
        const symList = [...allSyms].sort();
        console.log(
          `\n[load] ${tf} (${symList.length} symbols, target=${TARGET_COUNT}, pages=${MAX_PAGES})`,
        );
        const data = await loadAllSymbols(symList, tf);
        // report depths
        const depths = symList
          .map((s) => `${s}=${data[s]?.length ?? 0}`)
          .join(" ");
        console.log(`  depths: ${depths}`);
        tfData.set(tf, data);
      }

      const rows: SweepRow[] = [];

      for (const entry of CONFIGS) {
        const tfHours = TF_HOURS[entry.tf];
        const data = tfData.get(entry.tf)!;
        const symList = configSymbols(entry.cfg);
        const missing = symList.filter((s) => !data[s] || data[s].length === 0);
        if (missing.length > 0) {
          console.warn(
            `[skip] ${entry.name}: missing data for ${missing.join(",")}`,
          );
          continue;
        }
        const aligned = alignCommon(data, symList);
        const n = Math.min(...symList.map((s) => aligned[s].length));
        const yearsOfData = (n * tfHours) / 24 / 365;
        console.log(
          `\n[run] ${entry.name} (${entry.tf}, ${symList.length} sym, ${n} bars ≈ ${yearsOfData.toFixed(2)}y)`,
        );

        const cfgFalse: FtmoDaytrade24hConfig = {
          ...entry.cfg,
          liveMode: false,
        };
        const cfgTrue: FtmoDaytrade24hConfig = { ...entry.cfg, liveMode: true };

        const rFalse = walkForward(cfgFalse, aligned, tfHours);
        const rTrue = walkForward(cfgTrue, aligned, tfHours);

        rows.push({
          config: entry.name,
          tf: entry.tf,
          passFalse: rFalse.passRate * 100,
          passTrue: rTrue.passRate * 100,
          drift: (rTrue.passRate - rFalse.passRate) * 100,
          tlTrue: rTrue.tl,
          dlTrue: rTrue.dl,
          medTrue: rTrue.med,
          windows: rFalse.windows,
        });

        console.log(
          `  liveMode=false: ${(rFalse.passRate * 100).toFixed(2)}% (${rFalse.passes}/${rFalse.windows}) TL=${rFalse.tl} DL=${rFalse.dl} med=${rFalse.med}d`,
        );
        console.log(
          `  liveMode=true:  ${(rTrue.passRate * 100).toFixed(2)}% (${rTrue.passes}/${rTrue.windows}) TL=${rTrue.tl} DL=${rTrue.dl} med=${rTrue.med}d`,
        );
        const drift = rTrue.passRate - rFalse.passRate;
        console.log(
          `  drift: ${drift >= 0 ? "+" : ""}${(drift * 100).toFixed(2)}pp`,
        );
      }

      // Summary table — sorted by liveMode=true pass-rate desc.
      rows.sort((a, b) => b.passTrue - a.passTrue);

      console.log("\n\n========== ROUND-28 liveMode SWEEP RESULTS ==========");
      console.log(
        "Rank | Config              | TF   | Win | Mode-False | Mode-True | Drift   | TL-T | DL-T | Med-T",
      );
      console.log(
        "-----+---------------------+------+-----+------------+-----------+---------+------+------+------",
      );
      rows.forEach((r, i) => {
        const star = r.passTrue >= 75 ? " ★" : r.passTrue >= 70 ? " ◆" : "";
        console.log(
          `${String(i + 1).padStart(4)} | ${r.config.padEnd(19)} | ${r.tf.padEnd(4)} | ${String(r.windows).padStart(3)} | ${r.passFalse.toFixed(2).padStart(9)}% | ${r.passTrue.toFixed(2).padStart(8)}% | ${(r.drift >= 0 ? "+" : "") + r.drift.toFixed(2).padStart(6)}pp | ${String(r.tlTrue).padStart(4)} | ${String(r.dlTrue).padStart(4)} | ${String(r.medTrue).padStart(4)}d${star}`,
        );
      });
      console.log("\n★ ≥75% liveMode=true (VIABLE LIVE-DEPLOY)");
      console.log("◆ ≥70% liveMode=true (single-account ceiling candidate)");

      const top3 = rows.slice(0, 3);
      console.log("\nTop-3 by liveMode=true pass-rate:");
      top3.forEach((r, i) => {
        console.log(
          `  ${i + 1}. ${r.config} (${r.tf}) — ${r.passTrue.toFixed(2)}% / drift ${r.drift >= 0 ? "+" : ""}${r.drift.toFixed(2)}pp / TL ${r.tlTrue} / med ${r.medTrue}d`,
        );
      });
      const winners = rows.filter((r) => r.passTrue >= 75);
      const seventyPlus = rows.filter((r) => r.passTrue >= 70);
      console.log(
        `\nViable (≥75%): ${winners.length}/${rows.length} — ${winners.map((r) => r.config).join(", ") || "NONE"}`,
      );
      console.log(
        `70%+ ceiling: ${seventyPlus.length}/${rows.length} — ${seventyPlus.map((r) => r.config).join(", ") || "NONE"}`,
      );

      expect(rows.length).toBeGreaterThan(0);
    });
  },
);
