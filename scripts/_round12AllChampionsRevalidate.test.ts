/**
 * Round 12 — Re-validate all champion configs against the post-fix engine.
 *
 * Goal: produce honest pass-rates with PAUSE + NO-PAUSE side-by-side, so the
 * user knows which numbers are organic vs ping-trade-inflated.
 *
 * Engine fixes since most champions were last benchmarked:
 *   R77 — PTP slippage applied only to remaining fraction (was double-charged)
 *   R78 — Swap fee uses pragueDay (was UTC, mis-attributed crossings)
 *   R79 — PTP-BE stop level includes round-trip cost (was -cost loss at "BE")
 *
 * Configs tested (one champion per family):
 *   30m MR family:   V10_30M_OPT, V11_30M_OPT, V12_30M_OPT, V12_TURBO_30M_OPT
 *   15m MR family:   V13_15M_OPT, V16_15M_OPT
 *   1h / 2h MR:      V7_1H_OPT, V261_2H_OPT
 *   4h MR:           V232 (legacy speed champion)
 *   2h Trend V5:     V5_NOVA, V5_QUARTZ, V5_AMBER, V5_TITANIUM, V5_OBSIDIAN
 *   Step 2:          V5_STEP2, V5_QUARTZ_STEP2
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
  const stepBars = 3 * bpd; // 3-day step = standard speed-validation window
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0,
    totalW = 0;
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
    for (const t of res.trades) {
      totalT++;
      if (t.effPnl > 0) totalW++;
    }
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passRate: windows ? passes / windows : 0,
    tlPct: windows ? tl / windows : 0,
    dlPct: windows ? dl / windows : 0,
    avgTrades: windows ? totalT / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

interface ChampionEntry {
  name: string;
  cfg: FtmoDaytrade24hConfig;
  /**
   * The actual TF the strategy is tuned on. Required because V10/V11/V12/V13/
   * V16/V7 inherit `timeframe: "4h"` as a legacy engine tag from V230, but the
   * strategy is actually tuned on a finer TF. Memory warns about this exact
   * pitfall (CLAUDE.md "Initial test 1" note).
   */
  dataTf: "15m" | "30m" | "1h" | "2h" | "4h";
}

describe(
  "Round 12 — re-validate all champions on post-fix engine",
  { timeout: 90 * 60_000 },
  () => {
    it("PAUSE + NO-PAUSE side-by-side", async () => {
      const champions: ChampionEntry[] = [
        // 30m MR family — all inherit timeframe:"4h" as legacy engine tag
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
        // 15m MR family
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
        // 1h / 2h MR
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
        // 4h MR legacy
        { name: "V232 (4h)", cfg: FTMO_DAYTRADE_24H_CONFIG_V232, dataTf: "4h" },
        // V5 trend family
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
        // Step 2
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

      // Aggregate symbols across configs grouped by ACTUAL data TF (not the
      // legacy `cfg.timeframe` engine tag).
      const byTf: Record<string, Set<string>> = {};
      for (const { cfg, dataTf } of champions) {
        if (!byTf[dataTf]) byTf[dataTf] = new Set();
        for (const s of syms(cfg)) byTf[dataTf].add(s);
      }

      const dataByTf: Record<string, Record<string, Candle[]>> = {};
      for (const tf of Object.keys(byTf)) {
        dataByTf[tf] = {};
        const symbols = [...byTf[tf]].sort();
        // 5.71y horizon → ~100k bars on 30m, more on 15m/5m. Cap at 200k for 15m.
        const targetCount = tf === "15m" ? 200000 : 100000;
        const maxPages = tf === "15m" ? 240 : 120;
        console.log(`\nLoading ${symbols.length} symbols (${tf})...`);
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
        `\n${"config".padEnd(22)} ${"tf".padEnd(4)} ${"variant".padEnd(10)} ${"pass".padStart(7)}  ${"wr".padStart(5)} ${"med".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)} ${"DL%".padStart(5)} ${"trades".padStart(7)}`,
      );
      console.log("─".repeat(85));

      const summary: Array<{
        name: string;
        tf: string;
        pause: number;
        noPause: number;
        delta: number;
      }> = [];

      for (const { name, cfg, dataTf } of champions) {
        const tf = dataTf;
        const data = dataByTf[tf];
        if (!data) {
          console.log(`${name.padEnd(22)} ${tf} (no data)`);
          continue;
        }

        // PAUSE variant (engine default — pause-at-target preserved)
        const cfgPause = { ...cfg, pauseAtTargetReached: true };
        const rPause = evaluate(cfgPause, data, dataTf);

        // NO-PAUSE variant (organic: no ping-trade after target)
        const cfgNoPause = { ...cfg, pauseAtTargetReached: false };
        const rNoPause = evaluate(cfgNoPause, data, dataTf);

        if (!rPause || !rNoPause) {
          console.log(`${name.padEnd(22)} ${tf} (alignment fail)`);
          continue;
        }

        const fmtRow = (label: string, r: NonNullable<typeof rPause>) =>
          `${name.padEnd(22)} ${tf.padEnd(4)} ${label.padEnd(10)} ${(r.passRate * 100).toFixed(2).padStart(6)}%  ${(r.wr * 100).toFixed(1).padStart(4)}% ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${(r.tlPct * 100).toFixed(2).padStart(4)}% ${(r.dlPct * 100).toFixed(2).padStart(4)}% ${r.avgTrades.toFixed(1).padStart(7)}`;

        console.log(fmtRow("PAUSE", rPause));
        console.log(fmtRow("NO-PAUSE", rNoPause));
        const delta = rPause.passRate - rNoPause.passRate;
        const pauseInflated =
          delta >= 0.1
            ? " ⚠️ pause-inflated"
            : delta >= 0.05
              ? " ⚠ marginal"
              : "";
        console.log(
          `  Δ pause-vs-organic: ${(delta * 100).toFixed(2).padStart(6)}pp${pauseInflated}`,
        );
        summary.push({
          name,
          tf,
          pause: rPause.passRate,
          noPause: rNoPause.passRate,
          delta,
        });
      }

      // Sort by NO-PAUSE pass-rate (organic is what matters for live)
      summary.sort((a, b) => b.noPause - a.noPause);
      console.log("\n\n=== ORGANIC LEADERBOARD (NO-PAUSE pass-rate) ===");
      console.log(
        `${"#".padEnd(3)} ${"config".padEnd(22)} ${"tf".padEnd(4)} ${"organic".padStart(8)} ${"with-pause".padStart(11)} ${"Δ".padStart(7)}`,
      );
      for (let i = 0; i < summary.length; i++) {
        const s = summary[i];
        const flag = s.delta >= 0.1 ? " ⚠️" : s.noPause >= 0.55 ? " 🏆" : "";
        console.log(
          `${String(i + 1).padEnd(3)} ${s.name.padEnd(22)} ${s.tf.padEnd(4)} ${(s.noPause * 100).toFixed(2).padStart(7)}%  ${(s.pause * 100).toFixed(2).padStart(9)}%  ${(s.delta * 100).toFixed(2).padStart(5)}pp${flag}`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
