/**
 * THE HONEST TEST — every champion forced to obey FTMO live caps.
 *
 * Discovery: V261/V7/V10/V11/V12 base configs do NOT have liveCaps defined.
 * That means ETH-PYR (riskFrac=5.0) and adaptiveSizing factors run ungated,
 * letting backtests post effective position fractions of 5x-10x what FTMO
 * actually permits in live. The 87% V7 result was a bug-driven artifact.
 *
 * Force every config through:
 *   - liveCaps: maxStopPct: 0.05, maxRiskFrac: 0.4  (FTMO 4% per-trade limit)
 *   - pauseAtTargetReached: false  (organic; no ping-trade inflation)
 *
 * AND run a "PAUSE-only" variant (pause=true but liveCaps still enforced)
 * for comparison so we know the upside.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V232,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_STEP2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

const BARS_PER_DAY: Record<string, number> = {
  "15m": 96,
  "30m": 48,
  "1h": 24,
  "2h": 12,
  "4h": 6,
};

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

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  dataTf: string,
) {
  const bpd = BARS_PER_DAY[dataTf] ?? 48;
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (n === 0) return null;
  const winBars = cfg.maxDays * bpd;
  const stepBars = 3 * bpd;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0;
  const days: number[] = [];
  for (let start = 0; start + winBars <= n; start += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const s of symbols)
      slice[s] = aligned[s].slice(start, start + winBars);
    const res = runFtmoDaytrade24h(slice, cfg);
    windows++;
    if (res.passed) {
      passes++;
      if (res.passDay && res.passDay > 0) days.push(res.passDay);
    } else if (res.reason === "total_loss") tl++;
    else if (res.reason === "daily_loss") dl++;
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

interface ChampionEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  dataTf: "15m" | "30m" | "1h" | "2h" | "4h";
}

describe(
  "Round 12 HONEST FINAL — all bots forced into FTMO live caps",
  { timeout: 90 * 60_000 },
  () => {
    it("liveCaps + NO-PAUSE (organic, FTMO-real)", async () => {
      const champions: ChampionEntry[] = [
        {
          name: "V10_30M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
          dataTf: "30m",
        },
        {
          name: "V11_30M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V11_30M_OPT,
          dataTf: "30m",
        },
        {
          name: "V12_30M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
          dataTf: "30m",
        },
        {
          name: "V12_TURBO_30M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V12_TURBO_30M_OPT,
          dataTf: "30m",
        },
        {
          name: "V13_15M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V13_15M_OPT,
          dataTf: "15m",
        },
        {
          name: "V16_15M_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V16_15M_OPT,
          dataTf: "15m",
        },
        {
          name: "V7_1H_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
          dataTf: "1h",
        },
        {
          name: "V261_2H_OPT",
          cfg: FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
          dataTf: "2h",
        },
        { name: "V232", cfg: FTMO_DAYTRADE_24H_CONFIG_V232, dataTf: "4h" },
        {
          name: "V5_NOVA",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
          dataTf: "2h",
        },
        {
          name: "V5_QUARTZ",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
          dataTf: "30m",
        },
        {
          name: "V5_AMBER",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
          dataTf: "30m",
        },
        {
          name: "V5_TITANIUM",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
          dataTf: "30m",
        },
        {
          name: "V5_OBSIDIAN",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
          dataTf: "30m",
        },
        {
          name: "V5_STEP2",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_STEP2,
          dataTf: "2h",
        },
        {
          name: "V5_QUARTZ_STEP2",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_STEP2,
          dataTf: "30m",
        },
      ];

      const byTf: Record<string, Set<string>> = {};
      for (const { cfg, dataTf } of champions) {
        if (!byTf[dataTf]) byTf[dataTf] = new Set();
        for (const s of syms(cfg)) byTf[dataTf].add(s);
      }

      const dataByTf: Record<string, Record<string, Candle[]>> = {};
      for (const tf of Object.keys(byTf)) {
        dataByTf[tf] = {};
        const symbols = [...byTf[tf]].sort();
        const targetCount = tf === "15m" ? 200000 : 100000;
        const maxPages = tf === "15m" ? 240 : 120;
        console.log(`Loading ${symbols.length} symbols (${tf})...`);
        for (const s of symbols) {
          try {
            const r = await loadBinanceHistory({
              symbol: s,
              timeframe: tf as LiveTimeframe,
              targetCount,
              maxPages,
            });
            dataByTf[tf][s] = r.filter((c) => c.isFinal);
          } catch (e) {
            console.warn(`  skip ${s}: ${(e as Error).message}`);
          }
        }
      }

      console.log(
        `\n${"config".padEnd(22)} ${"tf".padEnd(4)} ${"variant".padEnd(13)} ${"pass".padStart(7)}  ${"med".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)} ${"DL%".padStart(5)}`,
      );
      console.log("─".repeat(75));

      const summary: Array<{
        name: string;
        tf: string;
        organic: number;
        pause: number;
      }> = [];

      for (const { name, cfg, dataTf } of champions) {
        const data = dataByTf[dataTf];
        if (!data) continue;

        // FORCE FTMO liveCaps + NO-PAUSE (organic, real-world)
        const cfgOrganic: FtmoDaytrade24hConfig = {
          ...cfg,
          liveCaps: FTMO_LIVE_CAPS,
          pauseAtTargetReached: false,
        };
        // FORCE FTMO liveCaps + PAUSE (live-bot with reliable ping discipline)
        const cfgPause: FtmoDaytrade24hConfig = {
          ...cfg,
          liveCaps: FTMO_LIVE_CAPS,
          pauseAtTargetReached: true,
        };

        const rOrganic = evaluate(cfgOrganic, data, dataTf);
        const rPause = evaluate(cfgPause, data, dataTf);
        if (!rOrganic || !rPause) continue;

        const fmtRow = (label: string, r: NonNullable<typeof rOrganic>) =>
          `${name.padEnd(22)} ${dataTf.padEnd(4)} ${label.padEnd(13)} ${(r.passRate * 100).toFixed(2).padStart(6)}% ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}% ${(r.dlPct * 100).toFixed(2).padStart(4)}%`;
        console.log(fmtRow("LC+ORGANIC", rOrganic));
        console.log(fmtRow("LC+PAUSE", rPause));
        summary.push({
          name,
          tf: dataTf,
          organic: rOrganic.passRate,
          pause: rPause.passRate,
        });
      }

      summary.sort((a, b) => b.organic - a.organic);
      console.log("\n=== HONEST LEADERBOARD (FTMO liveCaps + NO-PAUSE) ===");
      console.log(
        `${"#".padEnd(3)} ${"config".padEnd(22)} ${"tf".padEnd(4)} ${"organic".padStart(8)} ${"with-pause".padStart(11)}`,
      );
      for (let i = 0; i < summary.length; i++) {
        const s = summary[i];
        const flag = s.organic >= 0.55 ? " 🏆" : s.organic >= 0.4 ? " ✓" : "";
        console.log(
          `${String(i + 1).padEnd(3)} ${s.name.padEnd(22)} ${s.tf.padEnd(4)} ${(s.organic * 100).toFixed(2).padStart(7)}%  ${(s.pause * 100).toFixed(2).padStart(9)}%${flag}`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
