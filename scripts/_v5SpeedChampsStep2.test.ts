/**
 * V5 Speed-Champions in Step 2 mode + Step 1 push.
 * V5_ZIRKON, V5_AMBER, V5_QUARTZ, V5_TOPAZ — fast variants, see if they
 * also clear 55% on Step 2 with faster speed than V5_NOVA's med 9d.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
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

describe("V5 Speed-Champs in Step 2 mode", { timeout: 60 * 60_000 }, () => {
  it("ZIRKON, AMBER, QUARTZ, TOPAZ + Step 2", async () => {
    const variants: Array<[string, FtmoDaytrade24hConfig, string]> = [
      ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, "2h"],
      ["V5_HIWIN", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_HIWIN, "2h"],
      ["V5_NOVA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA, "2h"],
      ["V5_ZIRKON (30m)", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ZIRKON, "30m"],
      ["V5_AMBER (30m)", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_AMBER, "30m"],
      ["V5_QUARTZ (30m)", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ, "30m"],
      ["V5_TOPAZ (30m)", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TOPAZ, "30m"],
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
      `\n${"variant".padEnd(20)} STEP1-pass  med  p90 ‖ STEP2-pass  med  p90  TL%   DL%   trades`,
    );
    for (const [name, cfg, tf] of variants) {
      const data = tf === "30m" ? data30m : data2h;
      // Step 1 (default)
      const r1 = evaluate(cfg, data, tf);
      // Step 2 mode
      const cfg2 = { ...cfg, profitTarget: 0.05, maxDays: 60 };
      const r2 = evaluate(cfg2, data, tf);
      const star1 = r1.passRate >= 0.55 ? "✓" : " ";
      const star2 = r2.passRate >= 0.55 ? "✓" : " ";
      console.log(
        `${name.padEnd(20)} ${(r1.passRate * 100).toFixed(2).padStart(7)}%${star1} ${String(r1.med).padStart(2)}d ${String(r1.p90).padStart(2)}d ‖ ${(r2.passRate * 100).toFixed(2).padStart(7)}%${star2} ${String(r2.med).padStart(2)}d ${String(r2.p90).padStart(2)}d  ${((r2.tl / r2.windows) * 100).toFixed(1).padStart(5)}% ${((r2.dl / r2.windows) * 100).toFixed(1).padStart(5)}%  ${r2.avgTradesPerWindow.toFixed(2).padStart(5)}`,
      );
    }
    expect(true).toBe(true);
  });
});
