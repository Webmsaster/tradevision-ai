/**
 * Phase C.2: Kelly-Optimal Sizing on V3 baseline.
 * Position size based on rolling win-rate.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
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

describe("Phase C.2 Kelly Sizing", { timeout: 1800_000 }, () => {
  it("sweeps kellySizing parameters", async () => {
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

    const cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V3 BASELINE", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    const variants = [
      {
        label: "5/[0.5/0.7,0.65/1.3]",
        ks: {
          minTrades: 5,
          windowSize: 20,
          tiers: [
            { winRateAbove: 0.5, multiplier: 0.7 },
            { winRateAbove: 0.65, multiplier: 1.3 },
          ],
        },
      },
      {
        label: "10/[0.4/0.5,0.55/1.5]",
        ks: {
          minTrades: 10,
          windowSize: 30,
          tiers: [
            { winRateAbove: 0.4, multiplier: 0.5 },
            { winRateAbove: 0.55, multiplier: 1.5 },
          ],
        },
      },
      {
        label: "5/[0.4/0.5,0.5/1,0.6/1.8]",
        ks: {
          minTrades: 5,
          windowSize: 20,
          tiers: [
            { winRateAbove: 0.4, multiplier: 0.5 },
            { winRateAbove: 0.5, multiplier: 1 },
            { winRateAbove: 0.6, multiplier: 1.8 },
          ],
        },
      },
      {
        label: "3/[0.45/0.7,0.6/1.5]",
        ks: {
          minTrades: 3,
          windowSize: 10,
          tiers: [
            { winRateAbove: 0.45, multiplier: 0.7 },
            { winRateAbove: 0.6, multiplier: 1.5 },
          ],
        },
      },
      {
        label: "8/[0.45/0.5,0.55/1,0.65/2]",
        ks: {
          minTrades: 8,
          windowSize: 25,
          tiers: [
            { winRateAbove: 0.45, multiplier: 0.5 },
            { winRateAbove: 0.55, multiplier: 1 },
            { winRateAbove: 0.65, multiplier: 2 },
          ],
        },
      },
      {
        label: "10/[0.5/1,0.6/1.5,0.7/2]",
        ks: {
          minTrades: 10,
          windowSize: 30,
          tiers: [
            { winRateAbove: 0.5, multiplier: 1 },
            { winRateAbove: 0.6, multiplier: 1.5 },
            { winRateAbove: 0.7, multiplier: 2 },
          ],
        },
      },
    ];
    for (const v of variants) {
      const cfg = { ...cur, kellySizing: v.ks };
      const r = runWalkForward(data, cfg, TF_HOURS);
      console.log(fmt(`  ${v.label}`, r));
      if (score(r, best.r) < 0) best = { cfg, r, label: v.label };
    }
    console.log(`\n========== C.2 FINAL ==========`);
    console.log(fmt("V3 baseline", baseR));
    console.log(fmt(`winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
