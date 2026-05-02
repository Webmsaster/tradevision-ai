/**
 * Step 2 NO-PAUSE check: verify V5_QUARTZ Step 2 mode without pause inflation.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
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
  cfg: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  dataTf: string,
) {
  const bpd = BARS_PER_DAY[dataTf] ?? 12;
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * bpd;
  const stepBars = 3 * bpd;
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
    passes,
    passRate: windows ? passes / windows : 0,
    tl,
    dl,
    avgTradesPerWindow: windows ? totalT / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

describe("Step 2 NO-PAUSE robustness", { timeout: 60 * 60_000 }, () => {
  it("V5 family in Step 2 mode WITHOUT pause", async () => {
    const variants: Array<[string, FtmoDaytrade24hConfig, string]> = [
      ["V5_QUARTZ Step 2", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ, "30m"],
      ["V5_TOPAZ Step 2", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ, "30m"],
      ["V5_AMBER Step 2", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER, "30m"],
      ["V5_HIWIN Step 2", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN, "2h"],
    ];

    const allSyms = [
      ...new Set(variants.flatMap(([_, cfg]) => syms(cfg))),
    ].sort();
    console.log(`\nLoading ${allSyms.length} symbols (30m + 2h)...`);
    const data30m: Record<string, Candle[]> = {};
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
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        data2h[s] = r.filter((c) => c.isFinal);
      } catch {}
    }

    console.log(
      `\n${"variant".padEnd(28)} WITH-PAUSE       NO-PAUSE         Δ      med-NP  p90-NP  DL-NP%`,
    );
    for (const [name, cfg, tf] of variants) {
      const data = tf === "30m" ? data30m : data2h;
      const step2 = { ...cfg, profitTarget: 0.05, maxDays: 60 };
      const step2NP = { ...step2, pauseAtTargetReached: false };
      const r1 = evaluate(step2, data, tf);
      const r2 = evaluate(step2NP, data, tf);
      const star1 = r1.passRate >= 0.55 ? "✓" : " ";
      const star2 = r2.passRate >= 0.55 ? "✓" : " ";
      const dlNP = r2.windows ? ((r2.dl / r2.windows) * 100).toFixed(2) : "—";
      const delta = ((r1.passRate - r2.passRate) * 100).toFixed(2);
      console.log(
        `${name.padEnd(28)} ${(r1.passRate * 100).toFixed(2).padStart(7)}%${star1}  ${(r2.passRate * 100).toFixed(2).padStart(7)}%${star2}  -${delta.padStart(5)}pp  ${String(r2.med).padStart(2)}d   ${String(r2.p90).padStart(2)}d   ${dlNP.padStart(5)}%`,
      );
    }
    expect(true).toBe(true);
  });
});
