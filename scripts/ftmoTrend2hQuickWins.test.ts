/**
 * Quick-Win sweep on TREND_2H_V1: ADX + htfTrendFilter (long-direction confluence)
 * + volumeFilter. Goal: push 41.46% → 45-50%.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "SOLUSDT",
  "BCHUSDT",
  "DOGEUSDT",
];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe(
  "Trend 2h Quick Wins — ADX + HTF + Volume",
  { timeout: 1800_000 },
  () => {
    it("pushes via 3 quick-win filters", async () => {
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      console.log(`Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y)\n`);

      let cur: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
        liveCaps: LIVE_CAPS,
      };
      let curR = runWalkForward(data, cur, TF_HOURS);
      console.log(fmt("V1 BASELINE", curR));

      // R1: ADX trend-strength filter
      console.log(`\n--- R1: ADX trend-strength (skip choppy) ---`);
      let r1Best = { cfg: cur, r: curR };
      for (const period of [10, 14, 20, 28]) {
        for (const minAdx of [10, 15, 20, 25, 30]) {
          const cfg = { ...cur, adxFilter: { period, minAdx } };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r1Best.r) < 0) {
            r1Best = { cfg, r };
            console.log(fmt(`  ADX p${period} min=${minAdx}`, r));
          }
        }
      }
      cur = r1Best.cfg;
      console.log(fmt("R1 winner", r1Best.r));

      // R2: htfTrendFilter (apply to longs — only long when asset trending up)
      console.log(`\n--- R2: HTF Long-Confluence (positive threshold) ---`);
      let r2Best = { cfg: cur, r: r1Best.r };
      for (const lb of [12, 24, 48, 84, 168, 240]) {
        for (const thr of [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            htfTrendFilter: { lookbackBars: lb, apply: "long", threshold: thr },
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r2Best.r) < 0) {
            r2Best = { cfg, r };
            console.log(fmt(`  HTF lb=${lb} thr=${thr}`, r));
          }
        }
      }
      cur = r2Best.cfg;
      console.log(fmt("R2 winner", r2Best.r));

      // R3: volumeFilter
      console.log(`\n--- R3: volumeFilter ---`);
      let r3Best = { cfg: cur, r: r2Best.r };
      for (const period of [12, 24, 48, 100]) {
        for (const minRatio of [0.7, 1.0, 1.2, 1.5, 2.0, 2.5]) {
          const cfg = { ...cur, volumeFilter: { period, minRatio } };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r3Best.r) < 0) {
            r3Best = { cfg, r };
            console.log(fmt(`  vol p${period} min=${minRatio}`, r));
          }
        }
      }
      cur = r3Best.cfg;
      console.log(fmt("R3 winner", r3Best.r));

      // R4: combine — re-sweep ADX with current HTF + volume locked in
      console.log(`\n--- R4: ADX revisit on combined config ---`);
      let r4Best = { cfg: cur, r: r3Best.r };
      for (const period of [10, 14, 20, 28]) {
        for (const minAdx of [10, 15, 20, 25, 30, 35]) {
          const cfg = { ...cur, adxFilter: { period, minAdx } };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r4Best.r) < 0) {
            r4Best = { cfg, r };
            console.log(fmt(`  ADX p${period} min=${minAdx}`, r));
          }
        }
      }
      cur = r4Best.cfg;
      console.log(fmt("R4 winner", r4Best.r));

      console.log(`\n========== TREND_2H_V2 QUICK-WIN FINAL ==========`);
      console.log(fmt("V1 baseline", curR));
      console.log(fmt("V2 final   ", r4Best.r));
      console.log(
        `Δ V1→V2: +${((r4Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r4Best.r.p90Days - curR.p90Days}d p90`,
      );
      console.log(`\nFinal extras:`);
      if (cur.adxFilter) console.log(`  ADX: ${JSON.stringify(cur.adxFilter)}`);
      if (cur.htfTrendFilter)
        console.log(`  HTF: ${JSON.stringify(cur.htfTrendFilter)}`);
      if (cur.volumeFilter)
        console.log(`  Volume: ${JSON.stringify(cur.volumeFilter)}`);

      expect(r4Best.r.passRate).toBeGreaterThan(0);
    });
  },
);
