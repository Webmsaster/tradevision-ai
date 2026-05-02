/**
 * Sanity-check: is V5_FASTMAX > V5 a real edge or sweep noise?
 * Tries 3 different window-step values to see if the +0.89pp gap is robust.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const BARS_PER_DAY = 12;

function normalizeChallenge(cfg: FtmoDaytrade24hConfig) {
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
  cfgRaw: FtmoDaytrade24hConfig,
  data: Record<string, Candle[]>,
  stepBars: number,
) {
  const cfg = normalizeChallenge(cfgRaw);
  const symbols = syms(cfg);
  const aligned = alignCommon(data, symbols);
  const n = Math.min(...symbols.map((s) => aligned[s].length));
  const winBars = cfg.maxDays * BARS_PER_DAY;
  let windows = 0;
  let passes = 0;
  let tl = 0;
  let dl = 0;
  let to = 0;
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
    else if (res.reason === "time") to++;
  }
  days.sort((a, b) => a - b);
  return {
    windows,
    passes,
    passRate: passes / windows,
    tl,
    dl,
    to,
    med: days[Math.floor(days.length * 0.5)] ?? 0,
    p90: days[Math.floor(days.length * 0.9)] ?? 0,
  };
}

describe("V5 vs V5_FASTMAX edge robustness", { timeout: 30 * 60_000 }, () => {
  it("compares across multiple window-step anchors", async () => {
    const symbols = [
      ...new Set([
        ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
        ...syms(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX),
      ]),
    ].sort();
    const data: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const raw = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
      data[s] = raw.filter((c) => c.isFinal);
    }

    console.log(`\n--- V5 vs V5_FASTMAX edge robustness ---`);
    for (const stepDays of [1, 2, 3, 5, 7]) {
      const stepBars = stepDays * BARS_PER_DAY;
      const v5 = evaluate(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, data, stepBars);
      const fm = evaluate(
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FASTMAX,
        data,
        stepBars,
      );
      const delta = (fm.passRate - v5.passRate) * 100;
      console.log(
        `step=${stepDays}d windows=${v5.windows.toString().padStart(4)} | V5 ${(v5.passRate * 100).toFixed(2)}% (med ${v5.med}d, p90 ${v5.p90}d, TL ${v5.tl}, DL ${v5.dl}) | FASTMAX ${(fm.passRate * 100).toFixed(2)}% (med ${fm.med}d, p90 ${fm.p90}d, TL ${fm.tl}, DL ${fm.dl}) | Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`,
      );
    }

    expect(true).toBe(true);
  });
});
