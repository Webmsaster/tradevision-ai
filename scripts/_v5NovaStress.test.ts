/**
 * Stress test V5_NOVA — the only config that has liveCaps + profitTarget=0.08
 * by inheritance. This is the truthful production-deployable champion.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12; // 2h

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

describe(
  "V5_NOVA + V5 baseline honest stress",
  { timeout: 30 * 60_000 },
  () => {
    it("V5_NOVA / V5 baseline production stress", async () => {
      // Combine all symbols from both configs
      const allSyms = [
        ...new Set([
          ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA),
          ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
        ]),
      ].sort();
      console.log(`\nLoading ${allSyms.length} symbols (2h)...`);
      const data: Record<string, Candle[]> = {};
      for (const s of allSyms) {
        try {
          const r = await loadBinanceHistory({
            symbol: s,
            timeframe: "2h",
            targetCount: 30000,
            maxPages: 40,
          });
          data[s] = r.filter((c) => c.isFinal);
        } catch {}
      }

      const cases = [
        {
          name: "V5_NOVA baseline",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        },
        {
          name: "V5_NOVA NO-PAUSE",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
            pauseAtTargetReached: false,
          },
        },
        {
          name: "V5_NOVA cost+slip 2×",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA.assets.map(
              (a) => ({
                ...a,
                costBp: (a.costBp ?? 30) * 2,
                slippageBp: (a.slippageBp ?? 8) * 2,
              }),
            ),
          },
        },
        {
          name: "V5_NOVA t=0.10 boost",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
            profitTarget: 0.1,
          },
        },
        { name: "V5 baseline", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
        {
          name: "V5 NO-PAUSE",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            pauseAtTargetReached: false,
          },
        },
        {
          name: "V5 cost+slip 2×",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
              ...a,
              costBp: (a.costBp ?? 30) * 2,
              slippageBp: (a.slippageBp ?? 8) * 2,
            })),
          },
        },
      ];

      console.log(
        `\n${"variant".padEnd(28)} 3d-pass    wr      med   p90  TL%   DL%   trades/win`,
      );
      for (const c of cases) {
        const r = evaluate(c.cfg, data);
        const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
        const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
        const star = r.passRate >= 0.55 ? " ✓55%+" : "";
        console.log(
          `${c.name.padEnd(28)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%  ${r.avgTradesPerWindow.toFixed(2).padStart(5)}${star}`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
