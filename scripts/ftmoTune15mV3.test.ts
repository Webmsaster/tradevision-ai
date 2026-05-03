/**
 * V3 Phase: per-asset overrides + adaptiveSizing + triggerBars sweep on 15m.
 * Starts from V2 winner (76.06%, p90 6d).
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

// V2 winner re-applied
const V2_BASE: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V1,
  chandelierExit: { period: 168, mult: 4, minMoveR: 0.5 },
  partialTakeProfit: { triggerPct: 0.02, closeFraction: 0.3 },
  timeBoost: { afterDay: 2, equityBelow: 0.07, factor: 2.5 },
  liveCaps: LIVE_CAPS,
};

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("15m V3 — per-asset + adaptiveSizing", { timeout: 1800_000 }, () => {
  it("refines V2 → V3", async () => {
    const eth = await loadBinanceHistory({
      symbol: "ETHUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const btc = await loadBinanceHistory({
      symbol: "BTCUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const sol = await loadBinanceHistory({
      symbol: "SOLUSDT",
      timeframe: "15m",
      targetCount: 250000,
      maxPages: 250,
    });
    const n = Math.min(eth.length, btc.length, sol.length);
    const data = {
      ETHUSDT: eth.slice(-n),
      BTCUSDT: btc.slice(-n),
      SOLUSDT: sol.slice(-n),
    };
    console.log(`\n=== 15m V3 — ${(n / 96 / 365).toFixed(2)}y / ${n} bars ===`);

    let cur = V2_BASE;
    let curR = runWalkForward(data, cur, 0.25);
    console.log(fmt("V2 BASELINE", curR));

    // R1: per-asset triggerBars
    console.log(`\n--- R1: per-asset triggerBars ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const ethTb of [1, 2]) {
      for (const btcTb of [1, 2, 3]) {
        for (const solTb of [1, 2, 3]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            assets: cur.assets.map((a) => {
              if (a.symbol === "ETH-MR") return { ...a, triggerBars: ethTb };
              if (a.symbol === "BTC-MR") return { ...a, triggerBars: btcTb };
              if (a.symbol === "SOL-MR") return { ...a, triggerBars: solTb };
              return a;
            }),
          };
          const r = runWalkForward(data, cfg, 0.25);
          if (score(r, r1Best.r) < 0) {
            r1Best = { cfg, r };
            console.log(fmt(`  trig E${ethTb} B${btcTb} S${solTb}`, r));
          }
        }
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: per-asset stopPct/tpPct on ETH-MR (the main driver)
    console.log(`\n--- R2: ETH-MR stopPct × tpPct ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    for (const sp of [0.005, 0.008, 0.01, 0.012, 0.015]) {
      for (const tp of [0.01, 0.015, 0.02, 0.025, 0.03]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          assets: cur.assets.map((a) =>
            a.symbol === "ETH-MR" ? { ...a, stopPct: sp, tpPct: tp } : a,
          ),
        };
        const r = runWalkForward(data, cfg, 0.25);
        if (score(r, r2Best.r) < 0) {
          r2Best = { cfg, r };
          console.log(fmt(`  ETH sp=${sp} tp=${tp}`, r));
        }
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: adaptiveSizing tiers
    console.log(`\n--- R3: adaptiveSizing tiers ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    const tierVariants: Array<{ label: string; tiers: any[] }> = [
      {
        label: "current (V12 inherit)",
        tiers: cur.adaptiveSizing ?? [],
      },
      {
        label: "0.5/1.0/1.5",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.02, factor: 1.0 },
          { equityAbove: 0.05, factor: 1.5 },
        ],
      },
      {
        label: "0.75/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 0.75 },
          { equityAbove: 0.02, factor: 1.5 },
          { equityAbove: 0.05, factor: 2.0 },
        ],
      },
      {
        label: "1.0/1.5/2.0",
        tiers: [
          { equityAbove: 0, factor: 1.0 },
          { equityAbove: 0.025, factor: 1.5 },
          { equityAbove: 0.05, factor: 2.0 },
        ],
      },
      {
        label: "0.5/0.75/1.0/1.5",
        tiers: [
          { equityAbove: 0, factor: 0.5 },
          { equityAbove: 0.01, factor: 0.75 },
          { equityAbove: 0.03, factor: 1.0 },
          { equityAbove: 0.06, factor: 1.5 },
        ],
      },
    ];
    for (const v of tierVariants) {
      const cfg: FtmoDaytrade24hConfig = { ...cur, adaptiveSizing: v.tiers };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  tiers ${v.label}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: ETH-PYR & BTC/SOL minEquityGain — open trades earlier?
    console.log(`\n--- R4: equity gates ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const ethPyrGate of [0.001, 0.003, 0.005, 0.01]) {
      for (const btcSolGate of [0.005, 0.01, 0.02, 0.04]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          assets: cur.assets.map((a) => {
            if (a.symbol === "ETH-PYR")
              return { ...a, minEquityGain: ethPyrGate };
            if (a.symbol === "BTC-MR" || a.symbol === "SOL-MR")
              return { ...a, minEquityGain: btcSolGate };
            return a;
          }),
        };
        const r = runWalkForward(data, cfg, 0.25);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  PYR=${ethPyrGate} BTC/SOL=${btcSolGate}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    console.log(`\n========== V3 FINAL ==========`);
    console.log(fmt("V2 baseline", curR));
    console.log(fmt("V3 final   ", r4Best.r));
    console.log(
      `Δ V2→V3: +${((r4Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(`\nFinal config:`);
    console.log(
      JSON.stringify(
        {
          atrStop: cur.atrStop,
          chandelierExit: cur.chandelierExit,
          partialTakeProfit: cur.partialTakeProfit,
          timeBoost: cur.timeBoost,
          adaptiveSizing: cur.adaptiveSizing,
          assets: cur.assets,
        },
        null,
        2,
      ),
    );
    expect(r4Best.r.passRate).toBeGreaterThan(0);
  });
});
