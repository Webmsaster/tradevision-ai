/**
 * Quick Win 3: Random/Genetic param search around V3.
 * Explores wider param-space than grid sweep — catches non-obvious local optima.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import { mkRng, shuffled } from "./_passDayUtils";
import type { Candle } from "../src/utils/indicators";

// Deterministic PRNG so the random search is reproducible across runs.
const RNG_SEED = 0xc0ffee;
const rng = mkRng(RNG_SEED);

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

function rand(min: number, max: number) {
  return rng() * (max - min) + min;
}
function randInt(min: number, max: number) {
  return Math.floor(rand(min, max + 1));
}
function pickFrom<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

describe("Genetic / Random Param Search", { timeout: 1800_000 }, () => {
  it("explores wide param-space", async () => {
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

    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, baseCfg, TF_HOURS);
    console.log(fmt("V3 BASELINE", baseR));

    // Param-space:
    // - global tpPct: [0.05, 0.12]
    // - global stopPct: [0.025, 0.05]
    // - global triggerBars: [1, 3]
    // - global holdBars: [60, 480]
    // - trailingStop activatePct: [0.015, 0.06]
    // - trailingStop trailPct: [0.003, 0.02]
    // - allowedHoursUtc: random subset of [0,2,4,...,22] of size 4-12

    const N = 60; // 60 random samples
    let best = { cfg: baseCfg, r: baseR, params: "baseline" };

    console.log(`\n--- Random sampling (${N} variants) ---`);
    for (let trial = 0; trial < N; trial++) {
      const stopPct = rand(0.025, 0.05);
      const tpPct = stopPct * rand(1.1, 2.5); // R:R 1.1-2.5
      const tb = randInt(1, 3);
      const hb = randInt(60, 480);
      const trailAct = rand(0.015, 0.06);
      const trailPct = rand(0.003, 0.02);
      const allHrs = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
      const keepCount = randInt(6, 12);
      const picked = shuffled(allHrs, rng)
        .slice(0, keepCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        triggerBars: tb,
        stopPct,
        tpPct,
        holdBars: hb,
        allowedHoursUtc: picked,
        trailingStop: { activatePct: trailAct, trailPct },
        assets: baseCfg.assets.map((a) => ({
          ...a,
          stopPct,
          tpPct,
          triggerBars: tb,
          holdBars: hb,
        })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      if (score(r, best.r) < 0) {
        best = {
          cfg,
          r,
          params: `tb=${tb} sp=${stopPct.toFixed(3)} tp=${tpPct.toFixed(3)} hb=${hb} trail=(${trailAct.toFixed(3)},${trailPct.toFixed(3)}) hrs=${picked.length}`,
        };
        console.log(fmt(`  [${trial}] ${best.params}`, r));
      }
    }
    console.log(`\n========== GA RANDOM SEARCH FINAL ==========`);
    console.log(fmt("V3 baseline", baseR));
    console.log(fmt("Random search winner", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(`Params: ${best.params}`);
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
