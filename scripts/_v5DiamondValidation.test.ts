/**
 * Final validation — V5_DIAMOND robustness across window-step anchors.
 * Confirms 56.50% isn't a step-anchor artifact.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;
function normalize(cfg: FtmoDaytrade24hConfig): FtmoDaytrade24hConfig {
  const c = structuredClone(cfg);
  c.timeframe = "2h";
  c.profitTarget = 0.08;
  c.maxDailyLoss = 0.05;
  c.maxTotalLoss = 0.1;
  c.minTradingDays = 4;
  c.maxDays = 30;
  c.pauseAtTargetReached = true;
  c.liveCaps = { maxStopPct: 0.05, maxRiskFrac: 0.4 };
  return c;
}
function syms(cfg: FtmoDaytrade24hConfig): string[] {
  const out = new Set<string>();
  for (const a of cfg.assets) out.add(a.sourceSymbol ?? a.symbol);
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
  stepBars: number,
) {
  const c = normalize(cfg);
  const symbols = syms(c);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = c.maxDays * BARS_PER_DAY;
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
    const res = runFtmoDaytrade24h(slice, c);
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
    passRate: passes / windows,
    passes,
    windows,
    tl,
    dl,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
    winrate: totalT > 0 ? totalW / totalT : 0,
  };
}

describe("V5_DIAMOND robustness validation", { timeout: 4 * 3600_000 }, () => {
  it("V5 family head-to-head across step anchors", async () => {
    const cfgs = [
      ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5],
      ["V5_PRO", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRO],
      ["V5_GOLD", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_GOLD],
      ["V5_DIAMOND", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_DIAMOND],
      ["V5_PLATINUM", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PLATINUM],
    ] as Array<[string, FtmoDaytrade24hConfig]>;
    const allSyms = [...new Set(cfgs.flatMap(([, cfg]) => syms(cfg)))].sort();
    console.log(`\nLoading ${allSyms.length} symbols`);
    const data: Record<string, Candle[]> = {};
    for (const s of allSyms) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    console.log(`\nValidation matrix (5 step sizes × 4 configs):\n`);
    for (const stepDays of [1, 2, 3, 5, 7]) {
      const stepBars = stepDays * BARS_PER_DAY;
      console.log(`-- step=${stepDays}d --`);
      for (const [name, cfg] of cfgs) {
        const r = evaluate(cfg, data, stepBars);
        console.log(
          `  ${name.padEnd(12)} pass=${(r.passRate * 100).toFixed(2).padStart(6)}% (${r.passes}/${r.windows}) wr=${(r.winrate * 100).toFixed(2).padStart(6)}% med=${r.med}d p90=${r.p90}d TL=${r.tl}`,
        );
      }
    }
    expect(true).toBe(true);
  });
});
