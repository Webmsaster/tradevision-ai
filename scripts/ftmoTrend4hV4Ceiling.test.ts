/**
 * V4 Ceiling Push: maxConcurrentTrades + drawdown protection + filters.
 *
 * V2 (41,71%) had DL=287/645 = 44%. Concurrent-trade-limit should slash that.
 * Plus: drawdownShield, peakDrawdownThrottle, BTC-uptrend filter, time-of-day.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 4;

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

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

describe("Trend 4h V4 — push to ceiling", { timeout: 1800_000 }, () => {
  it("max concurrent + DD + filters", async () => {
    const candles: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      candles[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "4h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(candles).map((c) => c.length));
    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES) data[s] = candles[s].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 6 / 365).toFixed(2)}y)\n`);

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_4H_V2,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V2 BASELINE", curR));

    // R1: maxConcurrentTrades — main attack on DL=287
    console.log(`\n--- R1: maxConcurrentTrades ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const cap of [1, 2, 3, 4, 5, 6]) {
      const cfg = { ...cur, maxConcurrentTrades: cap };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r1Best.r) < 0) {
        r1Best = { cfg, r };
        console.log(fmt(`  maxConcurrent=${cap}`, r));
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: drawdownShield (absolute equity)
    console.log(`\n--- R2: drawdownShield ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const be of [-0.05, -0.04, -0.03, -0.02, -0.01]) {
      for (const f of [0, 0.1, 0.25, 0.4]) {
        const cfg = { ...cur, drawdownShield: { belowEquity: be, factor: f } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  dds be=${be} f=${f}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: peakDrawdownThrottle
    console.log(`\n--- R3: peakDrawdownThrottle ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const fp of [0.02, 0.03, 0.04, 0.05, 0.06]) {
      for (const f of [0, 0.1, 0.25, 0.4]) {
        const cfg = {
          ...cur,
          peakDrawdownThrottle: { fromPeak: fp, factor: f },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r3Best.r) < 0) {
          r3Best = { cfg, r };
          console.log(fmt(`  pdt fp=${fp} f=${f}`, r));
        }
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: BTC uptrend filter (skip longs when BTC bearish)
    console.log(`\n--- R4: HTF BTC trend gate ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const lb of [10, 20, 50, 100, 200]) {
      for (const thr of [-0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          htfTrendFilter: {
            lookbackBars: lb,
            apply: "long" as const,
            threshold: thr,
          },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  HTF lb=${lb} thr=${thr}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: greedy hour-drop
    console.log(`\n--- R5: greedy hour-drop ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    let bestHours = cur.allowedHoursUtc ?? [0, 4, 8, 12, 16, 20];
    let improved = true;
    let iter = 0;
    while (improved && iter < 4) {
      improved = false;
      for (const h of [...bestHours]) {
        const cand = bestHours.filter((x) => x !== h);
        if (cand.length < 3) continue;
        const cfg = { ...cur, allowedHoursUtc: cand };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r5Best.r) < 0) {
          r5Best = { cfg, r };
          bestHours = cand;
          improved = true;
          console.log(fmt(`  drop ${h}`, r));
        }
      }
      iter++;
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    // R6: lossStreakCooldown
    console.log(`\n--- R6: LSC ---`);
    let r6Best = { cfg: cur, r: r5Best.r };
    for (const after of [2, 3]) {
      for (const cd of [6, 12, 24, 48, 90]) {
        const cfg = {
          ...cur,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r6Best.r) < 0) {
          r6Best = { cfg, r };
          console.log(fmt(`  LSC ${after}/${cd}`, r));
        }
      }
    }
    cur = r6Best.cfg;
    console.log(fmt("R6 winner", r6Best.r));

    // R7: triggerBars revisit
    console.log(`\n--- R7: triggerBars ---`);
    let r7Best = { cfg: cur, r: r6Best.r };
    for (const tb of [1, 2, 3, 4]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r7Best.r) < 0) {
        r7Best = { cfg, r };
        console.log(fmt(`  tb=${tb}`, r));
      }
    }
    cur = r7Best.cfg;
    console.log(fmt("R7 winner", r7Best.r));

    // R8: chandelierExit (lock profit)
    console.log(`\n--- R8: chandelierExit ---`);
    let r8Best = { cfg: cur, r: r7Best.r };
    for (const period of [14, 28, 56, 84]) {
      for (const mult of [2, 3, 4, 5]) {
        const cfg = { ...cur, chandelierExit: { period, mult, minMoveR: 0.5 } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r8Best.r) < 0) {
          r8Best = { cfg, r };
          console.log(fmt(`  chand p${period} m${mult}`, r));
        }
      }
    }
    cur = r8Best.cfg;
    console.log(fmt("R8 winner", r8Best.r));

    // R9: timeBoost
    console.log(`\n--- R9: timeBoost ---`);
    let r9Best = { cfg: cur, r: r8Best.r };
    for (const day of [2, 4, 6, 12]) {
      for (const eb of [0.02, 0.05, 0.07]) {
        for (const f of [1.5, 2, 3]) {
          const cfg = {
            ...cur,
            timeBoost: { afterDay: day, equityBelow: eb, factor: f },
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, r9Best.r) < 0) {
            r9Best = { cfg, r };
            console.log(fmt(`  tb d=${day} eb=${eb} f=${f}`, r));
          }
        }
      }
    }
    cur = r9Best.cfg;
    console.log(fmt("R9 winner", r9Best.r));

    console.log(`\n========== TREND_4H_V4 FINAL ==========`);
    console.log(fmt("V2 baseline", curR));
    console.log(fmt("V4 final   ", r9Best.r));
    console.log(
      `Δ V2→V4: +${((r9Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(`Distance to 90%: ${(0.9 - r9Best.r.passRate) * 100}pp`);
    console.log(`\nFinal config:`);
    if (cur.maxConcurrentTrades)
      console.log(`  maxConcurrent: ${cur.maxConcurrentTrades}`);
    if (cur.drawdownShield)
      console.log(`  dds: ${JSON.stringify(cur.drawdownShield)}`);
    if (cur.peakDrawdownThrottle)
      console.log(`  pdt: ${JSON.stringify(cur.peakDrawdownThrottle)}`);
    if (cur.htfTrendFilter)
      console.log(`  HTF: ${JSON.stringify(cur.htfTrendFilter)}`);
    if (cur.allowedHoursUtc)
      console.log(`  hours: ${cur.allowedHoursUtc.join(",")}`);
    if (cur.lossStreakCooldown)
      console.log(`  LSC: ${JSON.stringify(cur.lossStreakCooldown)}`);
    if (cur.chandelierExit)
      console.log(`  chand: ${JSON.stringify(cur.chandelierExit)}`);
    if (cur.timeBoost) console.log(`  tb: ${JSON.stringify(cur.timeBoost)}`);
    console.log(`  triggerBars: ${cur.assets[0].triggerBars}`);

    expect(r9Best.r.passRate).toBeGreaterThan(0);
  });
});
