/**
 * V3 push: drawdown protection + R:R re-tune at trigger=1 + multi-TF mix.
 *
 * V2 had DL=287 (44%!) — too many daily-loss breaches. Need throttle.
 * Also try trigger=1 for faster entries (V1 was tb=1).
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

describe("Trend 4h V3 — DD protection + tweaks", { timeout: 1800_000 }, () => {
  it("attacks DL-breaches and pushes pass-rate", async () => {
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

    // R1: peakDrawdownThrottle to reduce DL/TL
    console.log(`\n--- R1: peakDrawdownThrottle ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const fp of [0.02, 0.025, 0.03, 0.035, 0.04, 0.05]) {
      for (const f of [0, 0.1, 0.25, 0.4]) {
        const cfg = {
          ...cur,
          peakDrawdownThrottle: { fromPeak: fp, factor: f },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r1Best.r) < 0) {
          r1Best = { cfg, r };
          console.log(fmt(`  pdt fp=${fp} f=${f}`, r));
        }
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: drawdownShield (absolute equity)
    console.log(`\n--- R2: drawdownShield ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const be of [-0.04, -0.03, -0.02, -0.015]) {
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

    // R3: lossStreakCooldown
    console.log(`\n--- R3: LSC ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const after of [2, 3]) {
      for (const cd of [6, 12, 24, 48, 90]) {
        const cfg = {
          ...cur,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r3Best.r) < 0) {
          r3Best = { cfg, r };
          console.log(fmt(`  LSC ${after}/${cd}`, r));
        }
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: BTC trend filter for longs
    console.log(`\n--- R4: HTF trend filter for longs ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const lb of [10, 20, 50, 100, 200]) {
      for (const thr of [-0.1, -0.05, 0, 0.02, 0.05, 0.1]) {
        const cfg = {
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

    // R5: trigger=1 fallback (V1 baseline approach with V2 assets)
    console.log(`\n--- R5: triggerBars revisit ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    for (const tb of [1, 2, 3, 4]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r5Best.r) < 0) {
        r5Best = { cfg, r };
        console.log(fmt(`  tb=${tb}`, r));
      }
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    // R6: holdBars
    console.log(`\n--- R6: holdBars ---`);
    let r6Best = { cfg: cur, r: r5Best.r };
    for (const hb of [12, 24, 60, 120, 180, 240, 360]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, r6Best.r) < 0) {
        r6Best = { cfg, r };
        console.log(fmt(`  hb=${hb}`, r));
      }
    }
    cur = r6Best.cfg;
    console.log(fmt("R6 winner", r6Best.r));

    // R7: chandelierExit (lock profits)
    console.log(`\n--- R7: chandelierExit ---`);
    let r7Best = { cfg: cur, r: r6Best.r };
    for (const period of [14, 28, 56, 84]) {
      for (const mult of [2, 3, 4, 5]) {
        const cfg = { ...cur, chandelierExit: { period, mult, minMoveR: 0.5 } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, r7Best.r) < 0) {
          r7Best = { cfg, r };
          console.log(fmt(`  chand p${period} m${mult}`, r));
        }
      }
    }
    cur = r7Best.cfg;
    console.log(fmt("R7 winner", r7Best.r));

    console.log(`\n========== TREND_4H_V3 FINAL ==========`);
    console.log(fmt("V2 baseline", curR));
    console.log(fmt("V3 final   ", r7Best.r));
    console.log(
      `Δ V2→V3: +${((r7Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(`\nFinal extras:`);
    if (cur.peakDrawdownThrottle)
      console.log(`  peakDD: ${JSON.stringify(cur.peakDrawdownThrottle)}`);
    if (cur.drawdownShield)
      console.log(`  dds: ${JSON.stringify(cur.drawdownShield)}`);
    if (cur.lossStreakCooldown)
      console.log(`  LSC: ${JSON.stringify(cur.lossStreakCooldown)}`);
    if (cur.htfTrendFilter)
      console.log(`  HTF: ${JSON.stringify(cur.htfTrendFilter)}`);
    if (cur.chandelierExit)
      console.log(`  chand: ${JSON.stringify(cur.chandelierExit)}`);
    console.log(`  triggerBars: ${cur.assets[0].triggerBars}`);
    console.log(`  holdBars: ${cur.assets[0].holdBars}`);

    expect(r7Best.r.windows).toBeGreaterThan(50);
  });
});
