/**
 * Round 28 — V13_LIVEFIRST_30M sweep.
 *
 * Goal: validate that V12_30M_OPT's drift-friendly engine stack ported to the
 * 9-asset V5_QUARTZ_LITE TREND basket reaches ≥75% backtest pass-rate while
 * using ONLY live-replicable features (no banned live-state accumulators).
 *
 * Strategy: load 30m bars for the 9 LITE assets, align by openTime to a
 * common timeline, then run rolling 30d windows step=3d via runFtmoDaytrade24h.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V13_LIVEFIRST_30M,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m bars

function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
  if (cfg.crossAssetFilter?.symbol) out.add(cfg.crossAssetFilter.symbol);
  for (const f of cfg.crossAssetFiltersExtra ?? []) out.add(f.symbol);
  return [...out].filter((s) => s.endsWith("USDT")).sort();
}

function alignCommon(data: Record<string, Candle[]>, symbols: string[]) {
  const sets = symbols.map(
    (s) => new Set((data[s] ?? []).map((c) => c.openTime)),
  );
  if (sets.length === 0) return {} as Record<string, Candle[]>;
  const common = [...sets[0]].filter((t) => sets.every((set) => set.has(t)));
  common.sort((a, b) => a - b);
  const cs = new Set(common);
  const aligned: Record<string, Candle[]> = {};
  for (const s of symbols)
    aligned[s] = (data[s] ?? []).filter((c) => cs.has(c.openTime));
  return aligned;
}

function pctile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
}

function evaluate(
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  maxBars: number,
) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  let n = Math.min(...symbols.map((s) => aligned[s]?.length ?? 0));
  if (!isFinite(n) || n === 0) return null;
  // Keep only most-recent maxBars to bound runtime.
  if (n > maxBars) {
    for (const s of symbols) aligned[s] = aligned[s].slice(n - maxBars);
    n = maxBars;
  }
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

describe("Round 28 — V13_LIVEFIRST_30M sweep", { timeout: 60 * 60_000 }, () => {
  it("evaluates V13_LIVEFIRST + LITE baseline on aligned 30m", async () => {
    const V13 = FTMO_DAYTRADE_24H_CONFIG_V13_LIVEFIRST_30M;
    const LITE = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ_LITE;
    const symbols = Array.from(new Set([...syms(V13), ...syms(LITE)])).sort();
    console.log(
      `Loading ${symbols.length} symbols (30m): ${symbols.join(",")}`,
    );
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
        console.log(`  ${s}: ${data[s].length} bars`);
      } catch (e) {
        console.log(`  ${s}: load failed — ${(e as Error).message}`);
      }
    }

    // Use ~3000-bar window (~62 days) of recent 30m data per asset for a quick
    // validation pass; downstream stress tests cover longer histories.
    const MAX_BARS = 3000;

    // Build LITE_NO_TRAIL_NO_PAUSE to isolate the BANNED-feature delta:
    // strip dailyPeakTrailingStop AND pauseAtTargetReached.
    const LITE_NO_BANNED: FtmoDaytrade24hConfig = {
      ...LITE,
      dailyPeakTrailingStop: undefined,
      pauseAtTargetReached: false,
    };
    const trials: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [
      { name: "LITE baseline (with banned trail+pause)", cfg: LITE },
      {
        name: "LITE - dailyPeakTrailingStop (still pause)",
        cfg: { ...LITE, dailyPeakTrailingStop: undefined },
      },
      {
        name: "LITE - pauseAtTargetReached (still trail)",
        cfg: { ...LITE, pauseAtTargetReached: false },
      },
      {
        name: "LITE - both banned (live-replicable LITE)",
        cfg: LITE_NO_BANNED,
      },
      { name: "V13_LIVEFIRST_30M (drift-friendly only)", cfg: V13 },
    ];

    console.log(
      `\n${"variant".padEnd(50)} ${"win".padStart(4)} ${"pass".padStart(7)} ${"med".padStart(4)} ${"p90".padStart(4)} ${"TL%".padStart(5)}`,
    );
    console.log("─".repeat(85));

    const results: Array<{
      name: string;
      pass: number;
      med: number;
      p90: number;
      tl: number;
      windows: number;
    }> = [];
    for (const { name, cfg } of trials) {
      const r = evaluate(cfg, data, MAX_BARS);
      if (!r) {
        console.log(`${name.padEnd(50)} (no data)`);
        continue;
      }
      const flag =
        r.passRate >= 0.85
          ? " GOAL+"
          : r.passRate >= 0.75
            ? " GOAL"
            : r.passRate >= 0.6
              ? " ok"
              : "";
      console.log(
        `${name.padEnd(50)} ${String(r.windows).padStart(4)} ${(
          r.passRate * 100
        )
          .toFixed(2)
          .padStart(
            6,
          )}% ${String(r.med).padStart(3)}d ${String(r.p90).padStart(3)}d ${(
          r.tlPct * 100
        )
          .toFixed(2)
          .padStart(4)}%${flag}`,
      );
      results.push({
        name,
        pass: r.passRate,
        med: r.med,
        p90: r.p90,
        tl: r.tlPct,
        windows: r.windows,
      });
    }

    const v13 = results.find((r) => r.name.includes("V13_LIVEFIRST"));
    if (v13) {
      const verdict =
        v13.pass >= 0.75
          ? `GOAL ACHIEVED (${(v13.pass * 100).toFixed(2)}% >= 75%)`
          : `BELOW GOAL (${(v13.pass * 100).toFixed(2)}% < 75%)`;
      console.log(`\n=== V13_LIVEFIRST_30M verdict: ${verdict} ===`);
    }
    expect(true).toBe(true);
  });
});
