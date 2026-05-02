/**
 * Sweep profitTarget 5-10% to find honest 55%+ on V5_QUARTZ.
 * Step 2 is 5%/60d — already 60%. Step 1 is 8%/30d — only 50%.
 * What about 6%/30d, 7%/30d, 8%/45d?
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ,
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
  "V5_QUARTZ profitTarget sweep — honest 55%",
  { timeout: 60 * 60_000 },
  () => {
    it("target/days variations + NO-PAUSE check", async () => {
      const symbols = syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ);
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

      const Q = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_QUARTZ;
      const top6 = (cfg: FtmoDaytrade24hConfig) =>
        cfg.assets.filter((a) =>
          [
            "ETH-TREND",
            "BTC-TREND",
            "BNB-TREND",
            "BCH-TREND",
            "LTC-TREND",
            "ADA-TREND",
          ].includes(a.symbol),
        );

      const cases: Array<{ name: string; cfg: FtmoDaytrade24hConfig }> = [
        // Target sweep with maxDays=30 (Step 1-like, lower target)
        {
          name: "QUARTZ top-6 t=8% / 30d (Step 1)",
          cfg: { ...Q, profitTarget: 0.08, maxDays: 30, assets: top6(Q) },
        },
        {
          name: "QUARTZ top-6 t=7% / 30d",
          cfg: { ...Q, profitTarget: 0.07, maxDays: 30, assets: top6(Q) },
        },
        {
          name: "QUARTZ top-6 t=6% / 30d",
          cfg: { ...Q, profitTarget: 0.06, maxDays: 30, assets: top6(Q) },
        },
        {
          name: "QUARTZ top-6 t=5% / 30d",
          cfg: { ...Q, profitTarget: 0.05, maxDays: 30, assets: top6(Q) },
        },
        // maxDays sweep with target=8%
        {
          name: "QUARTZ top-6 t=8% / 45d",
          cfg: { ...Q, profitTarget: 0.08, maxDays: 45, assets: top6(Q) },
        },
        {
          name: "QUARTZ top-6 t=8% / 60d (semi-Step 2)",
          cfg: { ...Q, profitTarget: 0.08, maxDays: 60, assets: top6(Q) },
        },
        // Best Step 2 baseline reference
        {
          name: "QUARTZ top-6 t=5% / 60d (Step 2)",
          cfg: { ...Q, profitTarget: 0.05, maxDays: 60, assets: top6(Q) },
        },
        // NO-PAUSE checks on best variants
        {
          name: "QUARTZ t=5%/30d NO-PAUSE",
          cfg: {
            ...Q,
            profitTarget: 0.05,
            maxDays: 30,
            pauseAtTargetReached: false,
            assets: top6(Q),
          },
        },
        {
          name: "QUARTZ t=5%/60d NO-PAUSE",
          cfg: {
            ...Q,
            profitTarget: 0.05,
            maxDays: 60,
            pauseAtTargetReached: false,
            assets: top6(Q),
          },
        },
        {
          name: "QUARTZ t=6%/30d NO-PAUSE",
          cfg: {
            ...Q,
            profitTarget: 0.06,
            maxDays: 30,
            pauseAtTargetReached: false,
            assets: top6(Q),
          },
        },
        {
          name: "QUARTZ t=7%/30d NO-PAUSE",
          cfg: {
            ...Q,
            profitTarget: 0.07,
            maxDays: 30,
            pauseAtTargetReached: false,
            assets: top6(Q),
          },
        },
        {
          name: "QUARTZ t=6%/45d NO-PAUSE",
          cfg: {
            ...Q,
            profitTarget: 0.06,
            maxDays: 45,
            pauseAtTargetReached: false,
            assets: top6(Q),
          },
        },
      ];

      console.log(
        `\n${"variant".padEnd(40)} 3d-pass    wr      med   p90  TL%   DL%`,
      );
      for (const c of cases) {
        const r = evaluate(c.cfg, data);
        const tlPct = r.windows ? ((r.tl / r.windows) * 100).toFixed(2) : "—";
        const dlPct = r.windows ? ((r.dl / r.windows) * 100).toFixed(2) : "—";
        const star = r.passRate >= 0.55 ? " ✓55%+" : "";
        console.log(
          `${c.name.padEnd(40)} ${(r.passRate * 100).toFixed(2).padStart(7)}% ${(r.wr * 100).toFixed(1).padStart(5)}%  ${String(r.med).padStart(2)}d  ${String(r.p90).padStart(2)}d  ${tlPct.padStart(5)}% ${dlPct.padStart(5)}%${star}`,
        );
      }
      expect(true).toBe(true);
    });
  },
);
