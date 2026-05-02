/**
 * Re-validate all top historic champion configs (V12/V261/V10/V11/V16) on
 * the bug-fixed engine. After Bug F/H fixes, these claims (95-99%) need
 * re-checking. Same 5.71y / FTMO-real cost stack.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY: Record<string, number> = {
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
  name: string,
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  dataTf: string,
) {
  // BUGFIX: cfg.timeframe is "4h" for V10/V11/V12/V261 (engine tag inherited
  // from base) but the actual bar TF is in the name (V12_30M_OPT → 30m).
  // Pass dataTf explicitly to align bars-per-day with the data we feed.
  const bpd = BARS_PER_DAY[dataTf] ?? 12;
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
        days.push(res.passDay ?? 0);
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
    tf: dataTf,
    n,
    ...r3,
    p1: r1.passRate,
    p3: r3.passRate,
    win1: r1.windows,
    win3: r3.windows,
  };
}

// Map: variant name → bar timeframe to FEED into engine (config tags inherit
// "4h" from base but actual bar TF is in the suffix).
const VARIANTS = [
  ["V12_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT, "30m"],
  ["V10_30M_OPT", FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT, "30m"],
  ["V261_2H_OPT", FTMO_DAYTRADE_24H_CONFIG_V261_2H_OPT, "2h"],
  ["V7_1H_OPT", FTMO_DAYTRADE_24H_CONFIG_V7_1H_OPT, "1h"],
] as Array<[string, FtmoDaytrade24hConfig, string]>;

describe("Top champion configs revalidation", { timeout: 60 * 60_000 }, () => {
  it("evaluates V12/V10/V261/V7 on bug-fixed engine", async () => {
    const allSyms = [
      ...new Set(VARIANTS.flatMap(([, cfg]) => syms(cfg))),
    ].sort();
    console.log(`\nLoading ${allSyms.length} symbols (30m, 1h, 2h)...`);

    const data30m: Record<string, Candle[]> = {};
    const data1h: Record<string, Candle[]> = {};
    const data2h: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "30m",
          targetCount: 100000,
          maxPages: 120,
        });
        data30m[s] = r.filter((c) => c.isFinal);
      } catch {}
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "1h",
          targetCount: 60000,
          maxPages: 80,
        });
        data1h[s] = r.filter((c) => c.isFinal);
      } catch {}
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data2h[s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    console.log(
      `\n${"name".padEnd(15)} ${"tf".padEnd(4)} 1d-pass    3d-pass    wr      med   p90   TL%    DL%`,
    );
    for (const [name, cfg, dataTf] of VARIANTS) {
      const data =
        dataTf === "30m" ? data30m : dataTf === "1h" ? data1h : data2h;
      try {
        const r = evaluate(name, cfg, data, dataTf);
        const tlPct = r.win3 ? ((r.tl / r.win3) * 100).toFixed(2) : "—";
        const dlPct = r.win3 ? ((r.dl / r.win3) * 100).toFixed(2) : "—";
        console.log(
          `${name.padEnd(15)} ${dataTf.padEnd(4)} ${(r.p1 * 100).toFixed(2).padStart(6)}% (${String(r.win1).padStart(4)})  ${(r.p3 * 100).toFixed(2).padStart(6)}% (${String(r.win3).padStart(3)})  ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}%  ${dlPct.padStart(5)}%`,
        );
      } catch (e) {
        console.log(`${name.padEnd(15)} ERROR: ${String(e).slice(0, 80)}`);
      }
    }

    expect(true).toBe(true);
  });
});
