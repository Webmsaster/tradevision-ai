/**
 * Phase 3b: Bollinger-Keltner Squeeze release as entry trigger.
 * Academic best params from PyQuantLab: BB(5, 1.5σ), KC(20, 1.5×ATR).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
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

describe("Phase 3b: BB-KC Squeeze", { timeout: 1800_000 }, () => {
  it("sweeps BB-KC Squeeze parameters", async () => {
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
    console.log(`Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y)\n`);

    const baseCfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, baseCfg, TF_HOURS);
    console.log(fmt("V2 BASELINE (N-green)", baseR));

    console.log(`\n--- BB-KC Squeeze sweep ---`);
    let best = { cfg: baseCfg, r: baseR, label: "n-green" };
    // PyQuantLab academic best: BB(5, 1.5), KC(20, 1.5)
    // Plus other reasonable variants
    const variants = [
      { bbP: 5, bbS: 1.5, kcP: 20, kcM: 1.5, sB: 1 },
      { bbP: 5, bbS: 1.5, kcP: 20, kcM: 1.5, sB: 3 },
      { bbP: 5, bbS: 1.5, kcP: 20, kcM: 1.5, sB: 5 },
      { bbP: 10, bbS: 2.0, kcP: 20, kcM: 1.5, sB: 3 },
      { bbP: 20, bbS: 2.0, kcP: 20, kcM: 1.5, sB: 3 },
      { bbP: 20, bbS: 2.0, kcP: 20, kcM: 2.0, sB: 3 },
      { bbP: 20, bbS: 2.0, kcP: 20, kcM: 2.5, sB: 3 },
      { bbP: 14, bbS: 2.0, kcP: 14, kcM: 2.0, sB: 3 },
      { bbP: 14, bbS: 1.8, kcP: 28, kcM: 1.5, sB: 5 },
    ];
    for (const v of variants) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: baseCfg.assets.map((a) => ({
          ...a,
          bbKcSqueezeEntry: {
            bbPeriod: v.bbP,
            bbSigma: v.bbS,
            kcPeriod: v.kcP,
            kcMult: v.kcM,
            minSqueezeBars: v.sB,
          },
        })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      const label = `BB(${v.bbP},${v.bbS}) KC(${v.kcP},${v.kcM}) sB=${v.sB}`;
      console.log(fmt(`  ${label}`, r));
      if (score(r, best.r) < 0) {
        best = { cfg, r, label };
      }
    }

    console.log(`\n========== PHASE 3b FINAL ==========`);
    console.log(fmt("V2 baseline (n-green)", baseR));
    console.log(fmt("Phase 3b winner", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    console.log(`Winner: ${best.label}`);

    expect(best.r.windows).toBeGreaterThan(50);
  });
});
