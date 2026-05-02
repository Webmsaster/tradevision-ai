/**
 * V12 deep audit (NO-PAUSE / cost cliff stress) — same methodology as V261/V7.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 48; // 30m

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
function evaluate(cfg: FtmoDaytrade24hConfig, data: Record<string, Candle[]>) {
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  const stepBars = 3 * BARS_PER_DAY;
  let windows = 0,
    passes = 0,
    tl = 0,
    dl = 0,
    totalT = 0,
    totalW = 0,
    insufficientDays = 0;
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
    else if (res.reason === "insufficient_days") insufficientDays++;
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
    insufficientDays,
    avgTradesPerWindow: windows ? totalT / windows : 0,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    wr: totalT > 0 ? totalW / totalT : 0,
  };
}

describe("V12/V10 deep audit", { timeout: 30 * 60_000 }, () => {
  it("NO-PAUSE + cost stress", async () => {
    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT);
    console.log(`\nLoading ${symbols.length} symbols (30m)...`);
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

    const cases = [
      { name: "V12 baseline", cfg: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT },
      {
        name: "V12 NO-PAUSE",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
          pauseAtTargetReached: false,
        },
      },
      {
        name: "V12 cost+slip 2×",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
          assets: FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT.assets.map((a) => ({
            ...a,
            costBp: (a.costBp ?? 30) * 2,
            slippageBp: (a.slippageBp ?? 8) * 2,
          })),
        },
      },
      { name: "V10 baseline", cfg: FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT },
      {
        name: "V10 NO-PAUSE",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
          pauseAtTargetReached: false,
        },
      },
      {
        name: "V10 cost+slip 2×",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT,
          assets: FTMO_DAYTRADE_24H_CONFIG_V10_30M_OPT.assets.map((a) => ({
            ...a,
            costBp: (a.costBp ?? 30) * 2,
            slippageBp: (a.slippageBp ?? 8) * 2,
          })),
        },
      },
    ];

    console.log(
      `\n${"variant".padEnd(20)} 3d-pass    wr      med   p90  TL%   DL%   insuf%  trades/win`,
    );
    for (const c of cases) {
      const r = evaluate(c.cfg, data);
      const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
      const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
      const insufPct = r.windows
        ? ((r.insufficientDays / r.windows) * 100).toFixed(2)
        : "—";
      console.log(
        `${c.name.padEnd(20)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%  ${insufPct.padStart(5)}%  ${r.avgTradesPerWindow.toFixed(2).padStart(5)}`,
      );
    }
    expect(true).toBe(true);
  });
});
