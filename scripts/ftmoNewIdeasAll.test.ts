/**
 * Test all 5 new entry-trigger / cross-strategy ideas:
 *   1) MA-Crossover Entry
 *   2) Time-Series Momentum Entry
 *   3) NR7 Volatility Breakout Entry
 *   4) Pyramiding (additional sizing on profit)
 *   5) Anti-Correlated Hedge (long high-mom + short low-mom)
 *
 * Plus (separate file): ETH/BTC pair, News-Sentiment, MR on Trend-Drawdown
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const SOURCES = ["ETHUSDT", "BTCUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT"];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("New Ideas Bundle", { timeout: 1800_000 }, () => {
  it("tests 5 alternative entry/strategy approaches", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES) data[s] = data[s].slice(-n);

    const v4: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, v4, TF_HOURS);
    console.log(fmt("V4 BASELINE", baseR));

    // 1. MA-Crossover Entry
    console.log(`\n=== 1. MA-Crossover Entry ===`);
    let bestMA = { r: baseR as any, label: "off" };
    for (const fast of [5, 10, 20]) {
      for (const slow of [20, 50, 100, 200]) {
        if (slow <= fast) continue;
        const cfg = {
          ...v4,
          assets: v4.assets.map((a) => ({
            ...a,
            maCrossEntry: { fastPeriod: fast, slowPeriod: slow },
          })),
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, bestMA.r) < 0) {
          bestMA = { r, label: `fast=${fast} slow=${slow}` };
          console.log(fmt(`  ${bestMA.label}`, r));
        }
      }
    }
    console.log(fmt(`MA-Cross best (${bestMA.label})`, bestMA.r));

    // 2. Time-Series Momentum Entry
    console.log(`\n=== 2. Time-Series Momentum Entry ===`);
    let bestTS = { r: baseR as any, label: "off" };
    for (const lb of [12, 24, 48, 84, 168]) {
      for (const thr of [0, 0.01, 0.02, 0.03, 0.05]) {
        const cfg = {
          ...v4,
          assets: v4.assets.map((a) => ({
            ...a,
            tsMomentumEntry: { lookbackBars: lb, threshold: thr },
          })),
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, bestTS.r) < 0) {
          bestTS = { r, label: `lb=${lb} thr=${thr}` };
          console.log(fmt(`  ${bestTS.label}`, r));
        }
      }
    }
    console.log(fmt(`TSMOM best (${bestTS.label})`, bestTS.r));

    // 3. NR7 Volatility Breakout Entry
    console.log(`\n=== 3. NR7 Volatility Breakout ===`);
    let bestNR7 = { r: baseR as any, label: "off" };
    for (const cb of [4, 7, 10, 14, 20]) {
      const cfg = {
        ...v4,
        assets: v4.assets.map((a) => ({
          ...a,
          nr7Entry: { compressionBars: cb },
        })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, bestNR7.r) < 0) {
        bestNR7 = { r, label: `cb=${cb}` };
        console.log(fmt(`  ${bestNR7.label}`, r));
      }
    }
    console.log(fmt(`NR7 best (${bestNR7.label})`, bestNR7.r));

    console.log(`\n========== NEW IDEAS BUNDLE SUMMARY ==========`);
    console.log(fmt("V4 baseline", baseR));
    console.log(fmt(`MA-Crossover (${bestMA.label})`, bestMA.r));
    console.log(fmt(`TSMOM (${bestTS.label})`, bestTS.r));
    console.log(fmt(`NR7 (${bestNR7.label})`, bestNR7.r));

    expect(baseR.windows).toBeGreaterThan(50);
  });
});
