/**
 * Round 14 — V5_QUARTZ + Anti-DL test.
 *
 * V5_NOVA hat plateau bei 62.95% pause. V5_QUARTZ hat aber:
 * - 15 Assets (mehr Diversifikation als V5_NOVA's 8)
 * - 30m timeframe (mehr Entry-Timing-Präzision)
 * - 81% wr in Round-12-Test (vs 64% wr V5_NOVA)
 *
 * Test if V5_QUARTZ + Anti-DL trail breaks the 65%+ ceiling.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import type { LiveTimeframe } from "../src/hooks/useLiveCandles";

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
  bpd: number,
) {
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

describe("Round 14 V5_QUARTZ + Anti-DL test", { timeout: 60 * 60_000 }, () => {
  it("compare V5_QUARTZ vs V5_AMBER vs V5_NOVA + Anti-DL", async () => {
    const configs = [
      {
        name: "V5_NOVA",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        tf: "2h" as const,
        bpd: 12,
      },
      {
        name: "V5_QUARTZ",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
        tf: "30m" as const,
        bpd: 48,
      },
      {
        name: "V5_AMBER",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
        tf: "30m" as const,
        bpd: 48,
      },
    ];

    // Load data per timeframe
    const dataByTf: Record<string, Record<string, Candle[]>> = {};
    for (const tf of ["2h", "30m"]) {
      dataByTf[tf] = {};
      const symSet = new Set<string>();
      for (const c of configs)
        if (c.tf === tf) for (const s of syms(c.cfg)) symSet.add(s);
      const symbols = [...symSet].sort();
      console.log(`Loading ${symbols.length} symbols (${tf})...`);
      for (const s of symbols) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: tf as LiveTimeframe,
            targetCount: 100000,
            maxPages: 120,
          });
          dataByTf[tf][s] = r.filter((c) => c.isFinal);
        } catch {}
      }
    }

    console.log(
      `\n${"config".padEnd(15)} ${"variant".padEnd(20)} ${"NO-PAUSE".padStart(8)} ${"PAUSE".padStart(7)} ${"TL%".padStart(5)} ${"DL%".padStart(5)}`,
    );
    console.log("─".repeat(70));

    const trails = [0.015, 0.02, 0.025, 0.03];

    const results: Array<{
      name: string;
      trail: number;
      organic: number;
      pause: number;
      tl: number;
      dl: number;
    }> = [];

    for (const { name, cfg, tf, bpd } of configs) {
      const data = dataByTf[tf];

      // Baseline (no Anti-DL)
      const baseOrg = evaluate(
        { ...cfg, liveCaps: FTMO_LIVE_CAPS, pauseAtTargetReached: false },
        data,
        bpd,
      );
      const basePause = evaluate(
        { ...cfg, liveCaps: FTMO_LIVE_CAPS, pauseAtTargetReached: true },
        data,
        bpd,
      );
      if (baseOrg && basePause) {
        console.log(
          `${name.padEnd(15)} ${"BASELINE".padEnd(20)} ${(baseOrg.passRate * 100).toFixed(2).padStart(7)}% ${(basePause.passRate * 100).toFixed(2).padStart(6)}% ${(basePause.tlPct * 100).toFixed(2).padStart(4)}% ${(basePause.dlPct * 100).toFixed(2).padStart(4)}%`,
        );
      }

      // Anti-DL trail variants
      for (const td of trails) {
        const cfgAdl: FtmoDaytrade24hConfig = {
          ...cfg,
          liveCaps: FTMO_LIVE_CAPS,
          dailyPeakTrailingStop: { trailDistance: td },
        };
        const rOrg = evaluate(
          { ...cfgAdl, pauseAtTargetReached: false },
          data,
          bpd,
        );
        const rPause = evaluate(
          { ...cfgAdl, pauseAtTargetReached: true },
          data,
          bpd,
        );
        if (!rOrg || !rPause) continue;
        const flag =
          rPause.passRate >= 0.7
            ? " 🏆"
            : rPause.passRate >= 0.65
              ? " ✓✓"
              : rPause.passRate >= 0.6
                ? " ✓"
                : "";
        console.log(
          `${name.padEnd(15)} ${`trail=${td}`.padEnd(20)} ${(rOrg.passRate * 100).toFixed(2).padStart(7)}% ${(rPause.passRate * 100).toFixed(2).padStart(6)}% ${(rPause.tlPct * 100).toFixed(2).padStart(4)}% ${(rPause.dlPct * 100).toFixed(2).padStart(4)}%${flag}`,
        );
        results.push({
          name,
          trail: td,
          organic: rOrg.passRate,
          pause: rPause.passRate,
          tl: rPause.tlPct,
          dl: rPause.dlPct,
        });
      }
    }

    results.sort((a, b) => b.pause - a.pause);
    console.log("\n=== TOP-5 ===");
    for (let i = 0; i < Math.min(5, results.length); i++) {
      const r = results[i];
      console.log(
        `${i + 1}. ${r.name} trail=${r.trail} organic=${(r.organic * 100).toFixed(2)}% pause=${(r.pause * 100).toFixed(2)}% TL=${(r.tl * 100).toFixed(2)}% DL=${(r.dl * 100).toFixed(2)}%`,
      );
    }
    expect(true).toBe(true);
  });
});
