/**
 * FINAL STRESS TEST + BUG AUDIT
 *
 * 1. Verify FTMO target rules (8% for Step 1, not 10%)
 * 2. Cost stress test (different slippage / cost levels)
 * 3. Drawdown stress test
 * 4. Regime stress test (worst-slice analysis)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/STRESS_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

describe("STRESS TEST + Audit", { timeout: 24 * 3600_000 }, () => {
  it("runs", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `STRESS START ${new Date().toISOString()}\n`);

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
    log(`Data: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    function evalCfg(cfg: FtmoDaytrade24hConfig) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      let p = 0,
        w = 0,
        tl = 0,
        dl = 0;
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) {
          p++;
          if (r.trades.length > 0)
            passDays.push(r.trades[r.trades.length - 1].day + 1);
        }
        if (r.reason === "total_loss") tl++;
        if (r.reason === "daily_loss") dl++;
        w++;
      }
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      return {
        passes: p,
        windows: w,
        passRate: p / w,
        tlRate: tl / w,
        dlRate: dl / w,
        engineMed: pick(0.5),
        engineP90: pick(0.9),
      };
    }

    log(`========== TEST 1: profitTarget AUDIT ==========`);
    const v5_10 = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5);
    log(
      `V5 with 10% target (current): ${(v5_10.passRate * 100).toFixed(2)}% TL=${(v5_10.tlRate * 100).toFixed(2)}% engineMed=${v5_10.engineMed}d`,
    );

    const v5_step1: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.08,
    };
    const r1 = evalCfg(v5_step1);
    log(
      `V5 with 8% target (FTMO Step 1!): ${(r1.passRate * 100).toFixed(2)}% TL=${(r1.tlRate * 100).toFixed(2)}% engineMed=${r1.engineMed}d  Δ=+${((r1.passRate - v5_10.passRate) * 100).toFixed(2)}pp`,
    );

    const v5_step2: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      profitTarget: 0.05,
      maxDays: 60,
    };
    const r2 = evalCfg(v5_step2);
    log(
      `V5 Step 2 (5% target, 60 days): ${(r2.passRate * 100).toFixed(2)}% TL=${(r2.tlRate * 100).toFixed(2)}% engineMed=${r2.engineMed}d`,
    );

    log(
      `\n========== TEST 2: COST STRESS (cost / slippage variations) ==========`,
    );
    for (const [name, costBp, slipBp] of [
      ["Optimistic Binance", 15, 3],
      ["Current default", 30, 8],
      ["FTMO realistic", 40, 12],
      ["High volatility burst", 60, 25],
      ["Extreme stress", 100, 50],
    ] as const) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets.map((a) => ({
          ...a,
          costBp,
          slippageBp: slipBp,
        })),
      };
      const r = evalCfg(cfg);
      log(
        `  ${name.padEnd(25)} (${costBp}bp/${slipBp}bp): ${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== TEST 3: REGIME STRESS — slice-by-slice ==========`);
    {
      const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
      const numSlices = Math.floor(n / sixMo);
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
      };
      log(`V5 (8% target) per-slice analysis:`);
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      for (let si = 0; si < numSlices; si++) {
        let p = 0,
          w = 0,
          tl = 0;
        const sliceStart = si * sixMo;
        const sliceEnd = (si + 1) * sixMo;
        const sliceStartDate = new Date(data[SOURCES[0]][sliceStart].openTime)
          .toISOString()
          .slice(0, 10);
        const sliceEndDate = new Date(data[SOURCES[0]][sliceEnd - 1].openTime)
          .toISOString()
          .slice(0, 10);
        for (let s = sliceStart; s + winBars <= sliceEnd; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfg);
          if (r.passed) p++;
          if (r.reason === "total_loss") tl++;
          w++;
        }
        log(
          `  Slice ${si} (${sliceStartDate} → ${sliceEndDate}): ${((p / w) * 100).toFixed(2)}% (${p}/${w}) TL=${tl}`,
        );
      }
    }

    log(`\n========== TEST 4: MAX-DRAWDOWN ANALYSIS ==========`);
    {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
      };
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      const maxDDs: number[] = [];
      for (let s = 0; s + winBars <= n; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const sym of SOURCES) sub[sym] = data[sym].slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        maxDDs.push(r.maxDrawdown);
      }
      maxDDs.sort((a, b) => a - b); // most negative first (worst DD)
      log(`Max-Drawdown Distribution (${maxDDs.length} windows):`);
      log(`  Worst: ${(maxDDs[0] * 100).toFixed(2)}%`);
      log(
        `  p10:   ${(maxDDs[Math.floor(maxDDs.length * 0.1)] * 100).toFixed(2)}%`,
      );
      log(
        `  p25:   ${(maxDDs[Math.floor(maxDDs.length * 0.25)] * 100).toFixed(2)}%`,
      );
      log(
        `  p50:   ${(maxDDs[Math.floor(maxDDs.length * 0.5)] * 100).toFixed(2)}%`,
      );
      log(
        `  Mean:  ${((maxDDs.reduce((a, b) => a + b, 0) / maxDDs.length) * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== TEST 5: LEVERAGE STRESS ==========`);
    for (const lev of [1, 1.5, 2, 2.5]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
        leverage: lev,
      };
      const r = evalCfg(cfg);
      log(
        `  leverage=${lev}: ${(r.passRate * 100).toFixed(2)}% TL=${(r.tlRate * 100).toFixed(2)}% engineMed=${r.engineMed}d`,
      );
    }

    log(`\n========== TEST 6: BLACK SWAN — single asset crash ==========`);
    {
      // Find biggest drop in any asset and check if windows around it pass
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        profitTarget: 0.08,
      };
      let worstWindow = -1;
      let worstWindowPct = 0;
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      for (let s = 0; s + winBars <= n; s += stepBars) {
        for (const sym of SOURCES) {
          const arr = data[sym].slice(s, s + winBars);
          const start = arr[0].close;
          const minP = Math.min(...arr.map((c) => c.low));
          const dropPct = (minP - start) / start;
          if (dropPct < worstWindowPct) {
            worstWindowPct = dropPct;
            worstWindow = s;
          }
        }
      }
      const startDate = new Date(data[SOURCES[0]][worstWindow].openTime)
        .toISOString()
        .slice(0, 10);
      log(
        `Worst single-asset drawdown: ${(worstWindowPct * 100).toFixed(2)}% in window starting ${startDate}`,
      );
      // Run V5 on that exact window
      const sub: Record<string, Candle[]> = {};
      for (const sym of SOURCES)
        sub[sym] = data[sym].slice(worstWindow, worstWindow + winBars);
      const r = runFtmoDaytrade24h(sub, cfg);
      log(
        `  V5 result on worst window: passed=${r.passed} reason=${r.reason} finalEquity=${(r.finalEquityPct * 100).toFixed(2)}% maxDD=${(r.maxDrawdown * 100).toFixed(2)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
