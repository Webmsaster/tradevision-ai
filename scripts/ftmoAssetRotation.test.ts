/**
 * Quick Win 2: Asset-Rotation — find best 1-7 asset subsets.
 * Maybe not all 8 assets help.
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

describe("Asset Rotation", { timeout: 1800_000 }, () => {
  it("greedy asset removal + greedy asset add", async () => {
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
    console.log(fmt("V3 BASELINE (8 assets)", baseR));

    // Greedy removal: drop the worst-contributing asset until no improvement
    console.log(`\n--- Greedy removal ---`);
    let best = { cfg: cur, r: baseR };
    let assetsLeft = [...cur.assets];
    while (assetsLeft.length > 2) {
      let stepBest: {
        cfg: FtmoDaytrade24hConfig;
        r: any;
        removed: string;
      } | null = null;
      for (const removeMe of assetsLeft) {
        const trial = {
          ...best.cfg,
          assets: assetsLeft.filter((a) => a.symbol !== removeMe.symbol),
        };
        const r = runWalkForward(data, trial, TF_HOURS);
        if (score(r, best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0) {
            stepBest = { cfg: trial, r, removed: removeMe.symbol };
          }
        }
      }
      if (stepBest === null) break;
      best = { cfg: stepBest.cfg, r: stepBest.r };
      assetsLeft = stepBest.cfg.assets;
      console.log(fmt(`  −${stepBest.removed}`, stepBest.r));
    }

    console.log(`\n========== ASSET ROTATION FINAL ==========`);
    console.log(fmt("V3 baseline (8 assets)", baseR));
    console.log(fmt(`Best subset (${assetsLeft.length} assets)`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(`Final assets: ${assetsLeft.map((a) => a.symbol).join(", ")}`);
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
