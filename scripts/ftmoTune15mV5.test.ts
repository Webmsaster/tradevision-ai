/**
 * V5 Phase: tpPct + kellySizing + holdBars + PTP fine-grain.
 * Last remaining single-axis tweaks before hitting the architecture wall.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("15m V5 — final remaining axes", { timeout: 1800_000 }, () => {
  it("sweeps tpPct, kelly, holdBars, PTP fine-grain", async () => {
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
    console.log(`\n=== 15m V5 — ${(n / 96 / 365).toFixed(2)}y / ${n} bars ===`);

    // Apply V4 winner first (caf ms=0.005 mb=6)
    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2,
      crossAssetFilter: {
        ...(FTMO_DAYTRADE_24H_CONFIG_LIVE_15M_V2.crossAssetFilter as any),
        momSkipShortAbove: 0.005,
        momentumBars: 6,
      },
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, 0.25);
    console.log(fmt("V4 BASELINE", curR));

    // R1: tpPct fine-grain
    console.log(`\n--- R1: tpPct sweep ---`);
    let r1Best = { cfg: cur, r: curR };
    for (const tp of [
      0.005, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025, 0.03, 0.04,
    ]) {
      const cfg = { ...cur, tpPct: tp };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r1Best.r) < 0) {
        r1Best = { cfg, r };
        console.log(fmt(`  tpPct=${tp}`, r));
      }
    }
    cur = r1Best.cfg;
    console.log(fmt("R1 winner", r1Best.r));

    // R2: kellySizing
    console.log(`\n--- R2: kellySizing variants ---`);
    let r2Best = { cfg: cur, r: r1Best.r };
    const kellyVariants: Array<{ label: string; ks: any | undefined }> = [
      { label: "off", ks: undefined },
      {
        label: "10/[wr0.5/0.5, wr0.6/1.0, wr0.7/1.5]",
        ks: {
          minTrades: 10,
          tiers: [
            { winRateAbove: 0.5, multiplier: 0.5 },
            { winRateAbove: 0.6, multiplier: 1.0 },
            { winRateAbove: 0.7, multiplier: 1.5 },
          ],
        },
      },
      {
        label: "5/[0.5/0.7, 0.65/1.3]",
        ks: {
          minTrades: 5,
          tiers: [
            { winRateAbove: 0.5, multiplier: 0.7 },
            { winRateAbove: 0.65, multiplier: 1.3 },
          ],
        },
      },
      {
        label: "8/[0.6/0.5, 0.7/1.0, 0.8/1.8]",
        ks: {
          minTrades: 8,
          tiers: [
            { winRateAbove: 0.6, multiplier: 0.5 },
            { winRateAbove: 0.7, multiplier: 1.0 },
            { winRateAbove: 0.8, multiplier: 1.8 },
          ],
        },
      },
      {
        label: "5/[0.5/1.0, 0.7/1.5]",
        ks: {
          minTrades: 5,
          tiers: [
            { winRateAbove: 0.5, multiplier: 1.0 },
            { winRateAbove: 0.7, multiplier: 1.5 },
          ],
        },
      },
    ];
    for (const v of kellyVariants) {
      const cfg = { ...cur, kellySizing: v.ks };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r2Best.r) < 0) {
        r2Best = { cfg, r };
        console.log(fmt(`  kelly ${v.label}`, r));
      }
    }
    cur = r2Best.cfg;
    console.log(fmt("R2 winner", r2Best.r));

    // R3: holdBars
    console.log(`\n--- R3: holdBars ---`);
    let r3Best = { cfg: cur, r: r2Best.r };
    for (const hb of [600, 1200, 1800, 2400, 3600, 4800]) {
      const cfg = { ...cur, holdBars: hb };
      const r = runWalkForward(data, cfg, 0.25);
      if (score(r, r3Best.r) < 0) {
        r3Best = { cfg, r };
        console.log(fmt(`  holdBars=${hb}`, r));
      }
    }
    cur = r3Best.cfg;
    console.log(fmt("R3 winner", r3Best.r));

    // R4: PTP fine-grain
    console.log(`\n--- R4: PTP fine-grain ---`);
    let r4Best = { cfg: cur, r: r3Best.r };
    for (const trigger of [0.003, 0.005, 0.008, 0.01, 0.015, 0.02, 0.025]) {
      for (const frac of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        const cfg = {
          ...cur,
          partialTakeProfit: { triggerPct: trigger, closeFraction: frac },
        };
        const r = runWalkForward(data, cfg, 0.25);
        if (score(r, r4Best.r) < 0) {
          r4Best = { cfg, r };
          console.log(fmt(`  PTP t=${trigger} f=${frac}`, r));
        }
      }
    }
    cur = r4Best.cfg;
    console.log(fmt("R4 winner", r4Best.r));

    console.log(`\n========== V5 FINAL ==========`);
    console.log(fmt("V4 baseline", curR));
    console.log(fmt("V5 final   ", r4Best.r));
    console.log(
      `Δ V4→V5: +${((r4Best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${r4Best.r.p90Days - curR.p90Days}d p90`,
    );
    console.log(`\nFinal config:`);
    console.log(
      JSON.stringify(
        {
          tpPct: cur.tpPct,
          holdBars: cur.holdBars,
          kellySizing: cur.kellySizing,
          partialTakeProfit: cur.partialTakeProfit,
          crossAssetFilter: cur.crossAssetFilter,
        },
        null,
        2,
      ),
    );
    expect(r4Best.r.passRate).toBeGreaterThan(0);
  });
});
