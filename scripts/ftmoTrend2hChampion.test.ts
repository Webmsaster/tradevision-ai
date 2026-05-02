/**
 * 2h Trend champion push — extend asset pool + tune sizing/filters.
 * Baseline: tb=1, sp=0.05, tp=0.07, hb=360 → 41.88% / 1d / p90 1d / TL=2.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const BARS_PER_DAY = 12;
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
) {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
}

function fmt(label: string, r: any) {
  return `${label.padEnd(35)} ${r.passes.toString().padStart(3)}/${r.windows} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

const POOL = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "SOLUSDT",
  "BCHUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "LTCUSDT",
  "DOTUSDT",
  "XRPUSDT",
  "MATICUSDT",
];

function trendAsset(
  s: string,
  sp = 0.05,
  tp = 0.07,
  hb = 360,
  tb = 1,
): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: tb,
    invertDirection: true,
    disableShort: true,
    stopPct: sp,
    tpPct: tp,
    holdBars: hb,
  };
}

describe("2h Trend Champion Push", { timeout: 1800_000 }, () => {
  it("fully optimizes 2h trend setup", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of POOL) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of POOL) data[s] = data[s].slice(-n);
    console.log(
      `Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y) / ${POOL.length} assets\n`,
    );

    // Start with 8 assets baseline
    const baseAssets = [
      "ETHUSDT",
      "BTCUSDT",
      "BNBUSDT",
      "ADAUSDT",
      "AVAXUSDT",
      "SOLUSDT",
      "BCHUSDT",
      "DOGEUSDT",
    ];
    let cur: FtmoDaytrade24hConfig = {
      triggerBars: 1,
      leverage: 2,
      tpPct: 0.07,
      stopPct: 0.05,
      holdBars: 360,
      timeframe: "4h" as any,
      assets: baseAssets.map((s) => trendAsset(s)),
      profitTarget: 0.1,
      maxDailyLoss: 0.05,
      maxTotalLoss: 0.1,
      minTradingDays: 4,
      maxDays: 30,
      pauseAtTargetReached: true,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur);
    console.log(fmt("BASELINE 8-asset 2h trend", curR));

    // R1: greedy add more
    console.log(`\n--- R1: greedy add assets ---`);
    let r1Best = { cfg: cur, r: curR };
    let candidates = POOL.filter((s) => !baseAssets.includes(s));
    while (true) {
      let stepBest: any = null;
      for (const s of candidates) {
        const trial = {
          ...r1Best.cfg,
          assets: [...r1Best.cfg.assets, trendAsset(s)],
        };
        const r = runWalkForward(data, trial);
        if (score(r, r1Best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0)
            stepBest = { cfg: trial, r, sym: s };
        }
      }
      if (stepBest === null) break;
      r1Best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((s) => s !== stepBest.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: stopPct/tpPct fine-grain
    console.log(`\n--- R2: R:R fine-grain ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const sp of [0.04, 0.045, 0.05]) {
      for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1]) {
        if (tp <= sp) continue;
        const cfg = {
          ...cur,
          assets: cur.assets.map((a) => ({ ...a, stopPct: sp, tpPct: tp })),
        };
        const r = runWalkForward(data, cfg);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  sp=${sp} tp=${tp}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: triggerBars
    console.log(`\n--- R3: triggerBars ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const tb of [1, 2, 3]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, triggerBars: tb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  tb=${tb}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: maxConcurrentTrades
    console.log(`\n--- R4: maxConcurrentTrades ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const cap of [1, 2, 3, 4, 5, 6, 8]) {
      const cfg = { ...cur, maxConcurrentTrades: cap };
      const r = runWalkForward(data, cfg);
      if (score(r, r4Best.r) < 0) {
        r4Best = { cfg, r };
        console.log(fmt(`  maxConcurrent=${cap}`, r));
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    // R5: adaptiveSizing
    console.log(`\n--- R5: adaptiveSizing ---`);
    let r5Best = { cfg: cur, r: r4Best.r };
    const sizings = [
      { label: "off", tiers: undefined },
      {
        label: "1.0/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 1.0 },
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.06, factor: 2.0 },
        ],
      },
      {
        label: "0.7/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.7 },
          { equityAbove: 0.03, factor: 1.5 },
          { equityAbove: 0.06, factor: 2.0 },
        ],
      },
      {
        label: "0.5/1.0/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 2.0 },
        ],
      },
      {
        label: "1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 1.5 },
          { equityAbove: 0.03, factor: 2.0 },
        ],
      },
    ];
    for (const v of sizings) {
      const cfg = { ...cur, adaptiveSizing: v.tiers };
      const r = runWalkForward(data, cfg);
      if (score(r, r5Best.r) < 0) {
        r5Best = { cfg, r };
        console.log(fmt(`  ${v.label}`, r));
      }
    }
    cur = r5Best.cfg;
    console.log(fmt("R5 winner", r5Best.r));

    // R6: timeBoost
    console.log(`\n--- R6: timeBoost ---`);
    let r6Best = { cfg: cur, r: r5Best.r };
    for (const day of [2, 4, 6, 12]) {
      for (const eb of [0.02, 0.05, 0.07]) {
        for (const f of [1.5, 2, 3]) {
          const cfg = {
            ...cur,
            timeBoost: { afterDay: day, equityBelow: eb, factor: f },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, r6Best.r) < 0) {
            r6Best = { cfg, r };
            console.log(fmt(`  tb d=${day} eb=${eb} f=${f}`, r));
          }
        }
      }
    }
    cur = r6Best.cfg;
    console.log(fmt("R6 winner", r6Best.r));

    // R7: holdBars
    console.log(`\n--- R7: holdBars ---`);
    let r7Best = { cfg: cur, r: r6Best.r };
    for (const hb of [60, 120, 240, 360, 480]) {
      const cfg = {
        ...cur,
        assets: cur.assets.map((a) => ({ ...a, holdBars: hb })),
      };
      const r = runWalkForward(data, cfg);
      if (score(r, r7Best.r) < 0) {
        r7Best = { cfg, r };
        console.log(fmt(`  hb=${hb}`, r));
      }
    }
    cur = r7Best.cfg;
    console.log(fmt("R7 winner", r7Best.r));

    console.log(`\n========== TREND_2H_V1 FINAL ==========`);
    console.log(fmt("Baseline 8-asset", curR));
    console.log(fmt("Final           ", r7Best.r));
    console.log(
      `Δ: +${((r7Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(
      `Distance to 90%: ${((0.9 - r7Best.r.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(
      `\nFinal asset list: ${cur.assets.map((a) => a.symbol).join(", ")}`,
    );
    console.log(
      `R:R: stop ${(cur.assets[0].stopPct ?? 0) * 100}% / tp ${(cur.assets[0].tpPct ?? 0) * 100}%`,
    );
    console.log(
      `triggerBars: ${cur.assets[0].triggerBars} | holdBars: ${cur.assets[0].holdBars}`,
    );
    if (cur.maxConcurrentTrades)
      console.log(`maxConcurrent: ${cur.maxConcurrentTrades}`);
    if (cur.adaptiveSizing)
      console.log(`adaptiveSizing: ${JSON.stringify(cur.adaptiveSizing)}`);
    if (cur.timeBoost)
      console.log(`timeBoost: ${JSON.stringify(cur.timeBoost)}`);

    expect(r7Best.r.passRate).toBeGreaterThan(0);
  });
});
