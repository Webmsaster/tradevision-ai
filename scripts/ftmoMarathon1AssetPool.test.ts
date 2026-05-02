/**
 * Marathon iteration 1: Greedy asset-pool expansion on V4 base.
 * V4 has 5 assets; pool of 13 — try add LINK/LTC/DOT/MATIC/AVAX/BCH/SOL/XRP.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const POOL = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "LINKUSDT",
  "LTCUSDT",
  "DOTUSDT",
  "MATICUSDT",
  "AVAXUSDT",
  "BCHUSDT",
  "SOLUSDT",
  "XRPUSDT",
];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

function trendAsset(s: string): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.07,
    holdBars: 240,
  };
}

describe("Marathon 1 - Asset Pool Expansion", { timeout: 1800_000 }, () => {
  it("greedy add from 13-asset pool", async () => {
    const data: Record<string, Candle[]> = {};
    for (const s of POOL)
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of POOL) data[s] = data[s].slice(-n);
    console.log(`Aligned: ${n} bars (${(n / 12 / 365).toFixed(2)}y)\n`);

    const v4Symbols = ["ETHUSDT", "BTCUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT"];
    const cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V4 baseline (5 assets)", baseR));

    // Greedy add from remaining pool
    let best = { cfg: cur, r: baseR };
    let candidates = POOL.filter((s) => !v4Symbols.includes(s));
    while (true) {
      let stepBest: { cfg: FtmoDaytrade24hConfig; r: any; sym: string } | null =
        null;
      for (const sym of candidates) {
        const trial = {
          ...best.cfg,
          assets: [...best.cfg.assets, trendAsset(sym)],
        };
        const r = runWalkForward(data, trial, TF_HOURS);
        if (score(r, best.r) < 0) {
          if (stepBest === null || score(r, stepBest.r) < 0)
            stepBest = { cfg: trial, r, sym };
        }
      }
      if (stepBest === null) break;
      best = { cfg: stepBest.cfg, r: stepBest.r };
      candidates = candidates.filter((s) => s !== stepBest.sym);
      console.log(fmt(`  +${stepBest.sym}`, stepBest.r));
    }
    console.log(`\n========== M1 FINAL ==========`);
    console.log(fmt("V4 baseline", baseR));
    console.log(fmt("Best subset", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    console.log(
      `Final assets: ${best.cfg.assets.map((a) => a.symbol).join(", ")}`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
