/**
 * Audit LIVE_1H_V1 / LIVE_2H_V1 / LIVE_15M_V1 — the actual deployable
 * configs WITH liveCaps applied. Compare to research-only V7/V261/V12.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY: Record<string, number> = { "15m": 96, "1h": 24, "2h": 12 };

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

describe("LIVE wrapper audit (with liveCaps)", { timeout: 30 * 60_000 }, () => {
  it("LIVE_1H_V1 / LIVE_2H_V1 NO-PAUSE + cost stress", async () => {
    const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1);
    console.log(`\nLoading ${symbols.length} symbols (15m, 1h, 2h)...`);
    const data15m: Record<string, Candle[]> = {};
    const data1h: Record<string, Candle[]> = {};
    const data2h: Record<string, Candle[]> = {};
    for (const s of symbols) {
      try {
        const r = await loadBinanceHistory({
          symbol: s,
          timeframe: "15m",
          targetCount: 100000,
          maxPages: 120,
        });
        data15m[s] = r.filter((c) => c.isFinal);
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

    const cases = [
      {
        name: "LIVE_2H baseline",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
        data: data2h,
        tf: "2h",
      },
      {
        name: "LIVE_2H NO-PAUSE",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
          pauseAtTargetReached: false,
        },
        data: data2h,
        tf: "2h",
      },
      {
        name: "LIVE_2H cost+slip 2×",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1,
          assets: FTMO_DAYTRADE_24H_CONFIG_LIVE_2H_V1.assets.map((a) => ({
            ...a,
            costBp: (a.costBp ?? 30) * 2,
            slippageBp: (a.slippageBp ?? 8) * 2,
          })),
        },
        data: data2h,
        tf: "2h",
      },
      {
        name: "LIVE_1H baseline",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
        data: data1h,
        tf: "1h",
      },
      {
        name: "LIVE_1H NO-PAUSE",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
          pauseAtTargetReached: false,
        },
        data: data1h,
        tf: "1h",
      },
      {
        name: "LIVE_1H cost+slip 2×",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1,
          assets: FTMO_DAYTRADE_24H_CONFIG_LIVE_1H_V1.assets.map((a) => ({
            ...a,
            costBp: (a.costBp ?? 30) * 2,
            slippageBp: (a.slippageBp ?? 8) * 2,
          })),
        },
        data: data1h,
        tf: "1h",
      },
      {
        name: "LIVE_15M baseline",
        cfg: FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
        data: data15m,
        tf: "15m",
      },
    ];

    console.log(
      `\n${"variant".padEnd(22)} 3d-pass    wr      med   p90  TL%   DL%   insuf%  trades/win`,
    );
    for (const c of cases) {
      const r = evaluate(c.cfg, c.data, c.tf);
      const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
      const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
      const insufPct = r.windows
        ? ((r.insufficientDays / r.windows) * 100).toFixed(2)
        : "—";
      console.log(
        `${c.name.padEnd(22)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%  ${insufPct.padStart(5)}%  ${r.avgTradesPerWindow.toFixed(2).padStart(5)}`,
      );
    }
    expect(true).toBe(true);
  });
});
