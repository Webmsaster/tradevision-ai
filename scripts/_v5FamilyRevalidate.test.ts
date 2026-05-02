/**
 * Re-validate the entire V5 family with the BUG-FIXED engine.
 * After 6 critical engine bugs were fixed (finishPausedPass off-by-one,
 * MCT/correlationFilter selection-bias, PTP same-bar no-BE, barsHeld
 * pullback, Kelly look-ahead, momentumRanking idx-1), every prior champion
 * claim is suspect. Find the TRUE post-fix champion.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY: Record<string, number> = { "30m": 48, "2h": 12 };

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
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
) {
  const tf = cfg.timeframe;
  const bpd = BARS_PER_DAY[tf] ?? 12;
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * bpd;
  const stepBars3 = 3 * bpd;
  const stepBars1 = 1 * bpd;
  const compute = (stepBars: number) => {
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
        if (res.passDay != null && res.passDay > 0) days.push(res.passDay);
      } else if (res.reason === "total_loss") tl++;
      else if (res.reason === "daily_loss") dl++;
      for (const t of res.trades) {
        totalT++;
        if (t.effPnl > 0) totalW++;
      }
    }
    days.sort((a, b) => a - b);
    return {
      passes,
      windows,
      tl,
      dl,
      passRate: windows ? passes / windows : 0,
      med: days[Math.floor(days.length * 0.5)] ?? 0,
      p90: days[Math.floor(days.length * 0.9)] ?? 0,
      wr: totalT > 0 ? totalW / totalT : 0,
    };
  };
  const r1 = compute(stepBars1);
  const r3 = compute(stepBars3);
  return {
    name,
    tf,
    n,
    ...r3,
    p1: r1.passRate,
    p3: r3.passRate,
    win1: r1.windows,
    win3: r3.windows,
  };
}

const VARIANTS = [
  ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5],
  ["V5_FASTMAX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX],
  ["V5_HIWIN", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN],
  ["V5_PRO", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO],
  ["V5_GOLD", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD],
  ["V5_DIAMOND", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND],
  ["V5_PLATINUM", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM],
  ["V5_PLATINUM_30M", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM_30M],
  ["V5_TITANIUM", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITANIUM],
  ["V5_OBSIDIAN", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OBSIDIAN],
  ["V5_ZIRKON", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON],
  ["V5_AMBER", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER],
  ["V5_QUARTZ", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ],
  ["V5_TOPAZ", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ],
  ["V5_RUBIN", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RUBIN],
  ["V5_SAPPHIR", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_SAPPHIR],
  ["V5_EMERALD", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_EMERALD],
  ["V5_PEARL", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PEARL],
  ["V5_OPAL", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_OPAL],
  ["V5_AGATE", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AGATE],
  ["V5_JADE", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_JADE],
  ["V5_ONYX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ONYX],
  ["V5_NOVA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA],
  ["V5_PRIMEX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX],
] as Array<[string, FtmoDaytrade24hConfig]>;

describe("V5-family revalidation post-bugfix", { timeout: 60 * 60_000 }, () => {
  it("evaluates all V5 variants on fixed engine", async () => {
    const allSyms = [
      ...new Set(VARIANTS.flatMap(([, cfg]) => syms(cfg))),
    ].sort();
    console.log(`\nLoading ${allSyms.length} symbols (30m + 2h)...`);

    const data30m: Record<string, Candle[]> = {};
    const data2h: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      try {
        const r30 = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        data30m[s] = r30.filter((c) => c.isFinal);
      } catch (e) {
        console.log(`  ${s} 30m FAILED: ${String(e).slice(0, 60)}`);
      }
      try {
        const r2h = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data2h[s] = r2h.filter((c) => c.isFinal);
      } catch (e) {
        console.log(`  ${s} 2h FAILED: ${String(e).slice(0, 60)}`);
      }
    }

    console.log(
      `\n${"name".padEnd(20)} ${"tf".padEnd(4)} 1d-pass    3d-pass    wr      med   p90   TL%    DL%`,
    );
    const results: ReturnType<typeof evaluate>[] = [];
    for (const [name, cfg] of VARIANTS) {
      const data = cfg.timeframe === "30m" ? data30m : data2h;
      try {
        const r = evaluate(name, cfg, data);
        results.push(r);
        const tlPct = r.win3 ? ((r.tl / r.win3) * 100).toFixed(2) : "—";
        const dlPct = r.win3 ? ((r.dl / r.win3) * 100).toFixed(2) : "—";
        console.log(
          `${name.padEnd(20)} ${cfg.timeframe.padEnd(4)} ${(r.p1 * 100).toFixed(2).padStart(6)}% (${String(r.win1).padStart(4)})  ${(r.p3 * 100).toFixed(2).padStart(6)}% (${String(r.win3).padStart(3)})  ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}%  ${dlPct.padStart(5)}%`,
        );
      } catch (e) {
        console.log(
          `${name.padEnd(20)} ${cfg.timeframe.padEnd(4)} ERROR: ${String(e).slice(0, 60)}`,
        );
      }
    }

    console.log(`\n=== TOP 10 BY 1d PASS-RATE (med ≤ 5d) ===`);
    const top1 = results
      .filter((r) => r.med > 0 && r.med <= 5)
      .sort((a, b) => b.p1 - a.p1);
    for (const r of top1.slice(0, 10))
      console.log(
        `${r.name.padEnd(20)} 1d=${(r.p1 * 100).toFixed(2)}% / 3d=${(r.p3 * 100).toFixed(2)}% / wr=${(r.wr * 100).toFixed(1)}% / med=${r.med}d / TL=${r.tl}/${r.win3}`,
      );

    expect(results.length).toBeGreaterThan(0);
  });
});
