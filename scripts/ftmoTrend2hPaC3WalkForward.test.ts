/**
 * Phase C.3: Walk-Forward Re-Optimization demo.
 * Train on first 70% of history → pick best trailing-stop params → test on last 30%.
 * Compare vs static V3 baseline on the same test window.
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

describe("Phase C.3 Walk-Forward Re-Opt", { timeout: 1800_000 }, () => {
  it("compares static vs walk-forward optimized", async () => {
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

    // Split: 70% train, 30% test
    const split = Math.floor(n * 0.7);
    const trainData: Record<string, Candle[]> = {};
    const testData: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      trainData[s] = data[s].slice(0, split);
      testData[s] = data[s].slice(split);
    }
    console.log(
      `Train: ${split} bars (${(split / 12 / 365).toFixed(2)}y) | Test: ${n - split} bars (${((n - split) / 12 / 365).toFixed(2)}y)\n`,
    );

    const cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const staticTestR = runWalkForward(testData, cur, TF_HOURS);
    console.log(fmt("Static V3 on TEST", staticTestR));

    // Tune trailingStop params on TRAIN
    console.log(`\n--- Tuning on TRAIN ---`);
    let bestTrain = {
      cfg: cur,
      r: { passRate: 0, p90Days: 999 } as any,
      label: "current",
    };
    for (const ap of [0.015, 0.02, 0.03, 0.04, 0.05]) {
      for (const tp of [0.003, 0.005, 0.008, 0.01, 0.015, 0.02, 0.03]) {
        const cfg = { ...cur, trailingStop: { activatePct: ap, trailPct: tp } };
        const r = runWalkForward(trainData, cfg, TF_HOURS);
        if (score(r, bestTrain.r) < 0) {
          bestTrain = { cfg, r, label: `ap=${ap} tp=${tp}` };
        }
      }
    }
    console.log(fmt(`TRAIN winner (${bestTrain.label})`, bestTrain.r));

    // Apply train winner to TEST
    const wfTestR = runWalkForward(testData, bestTrain.cfg, TF_HOURS);
    console.log(fmt(`Walk-forward on TEST (${bestTrain.label})`, wfTestR));

    console.log(`\n========== C.3 FINAL ==========`);
    console.log(fmt("Static V3 on TEST", staticTestR));
    console.log(fmt("Walk-forward on TEST", wfTestR));
    console.log(
      `Δ: +${((wfTestR.passRate - staticTestR.passRate) * 100).toFixed(2)}pp pass`,
    );
    expect(wfTestR.windows).toBeGreaterThan(20);
  });
});
