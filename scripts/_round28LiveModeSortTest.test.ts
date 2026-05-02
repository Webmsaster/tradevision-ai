/**
 * Round 28 — liveMode (entry-time sort) vs default (exit-time sort).
 *
 * Tests V5_QUARTZ_LITE under two engine modes:
 *   - liveMode=false (default): sort `all` by exit-time (back-compat)
 *   - liveMode=true: sort `all` by entry-time (closer to what a live bot
 *     would see when deciding which trade to take next)
 *
 * Hypothesis: if exit-time sort is "future-lookahead-unfair" (i.e. a
 * trade that exits earlier gets to apply its PnL to equity BEFORE a
 * concurrently-running trade that entered earlier but exits later),
 * then liveMode=true should produce a different (likely lower) pass rate.
 *
 * If the two numbers match closely → exit-time sort is just numerical
 * ordering, no fairness issue. If they diverge → exit-time sort is the
 * source of backtest inflation.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48;

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
  "Round 28 — liveMode (entry-time sort) vs default (exit-time sort)",
  { timeout: 60 * 60_000 },
  () => {
    it("compares V5_QUARTZ_LITE pass-rate under both sort modes", async () => {
      const LITE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
      const symbols = syms(LITE);
      console.log(`Loading ${symbols.length} symbols (30m)...`);
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

      const baseCfg: FtmoDaytrade24hConfig = {
        ...LITE,
        liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
        pauseAtTargetReached: true,
      };

      console.log("\n=== A: BACKTEST (liveMode=false / exit-time sort) ===");
      const A = evaluate({ ...baseCfg, liveMode: false }, data);
      console.log(
        `windows=${A?.windows} pass=${((A?.passRate ?? 0) * 100).toFixed(2)}%` +
          ` tl=${((A?.tlPct ?? 0) * 100).toFixed(2)}%` +
          ` dl=${((A?.dlPct ?? 0) * 100).toFixed(2)}%` +
          ` med=${A?.med}d p75=${A?.p75}d p90=${A?.p90}d`,
      );

      console.log("\n=== B: LIVEMODE (entry-time sort) ===");
      const B = evaluate({ ...baseCfg, liveMode: true }, data);
      console.log(
        `windows=${B?.windows} pass=${((B?.passRate ?? 0) * 100).toFixed(2)}%` +
          ` tl=${((B?.tlPct ?? 0) * 100).toFixed(2)}%` +
          ` dl=${((B?.dlPct ?? 0) * 100).toFixed(2)}%` +
          ` med=${B?.med}d p75=${B?.p75}d p90=${B?.p90}d`,
      );

      const drift = (A!.passRate - B!.passRate) * 100;
      console.log(`\n=== DRIFT: ${drift.toFixed(2)}pp (A − B) ===`);
      console.log(
        drift > 5
          ? "⚠️ LARGE DRIFT — exit-time sort is inflating backtest numbers."
          : drift > 1
            ? "Modest drift — exit-time sort gives small lift."
            : "Negligible drift — exit-time sort is a no-op for this config.",
      );

      expect(A).not.toBeNull();
      expect(B).not.toBeNull();
    });
  },
);
