/**
 * Phase A.1: Per-Asset Asymmetric R:R sweep on TREND_2H_V1.
 * Each asset gets its own optimal stopPct/tpPct based on its vol profile.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
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

describe("Phase A.1 Asymmetric R:R per asset", { timeout: 1800_000 }, () => {
  it("optimizes each asset's stop/tp independently", async () => {
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

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1 BASELINE (uniform sp=5% tp=7%)", baseR));

    // Greedy: for each asset, find best (sp, tp) holding others constant
    console.log(`\n--- Per-asset greedy R:R optimization ---`);
    const stops = [0.025, 0.035, 0.045, 0.05];
    const tps = [0.04, 0.05, 0.06, 0.07, 0.08, 0.1];

    const tunedRR: Record<string, { sp: number; tp: number }> = {};
    for (const targetSym of SOURCES) {
      const targetSymKey = `${targetSym.replace("USDT", "")}-TREND`;
      let best = { sp: 0.05, tp: 0.07, r: undefined as any };
      for (const sp of stops) {
        for (const tp of tps) {
          if (tp <= sp) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            assets: cur.assets.map((a) =>
              a.symbol === targetSymKey ? { ...a, stopPct: sp, tpPct: tp } : a,
            ),
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (best.r === undefined || score(r, best.r) < 0) {
            best = { sp, tp, r };
          }
        }
      }
      tunedRR[targetSym] = { sp: best.sp, tp: best.tp };
      console.log(
        `  ${targetSymKey}: best sp=${best.sp} tp=${best.tp} → ${(best.r.passRate * 100).toFixed(2)}% / p90=${best.r.p90Days}`,
      );
    }

    // Apply all tuned R:R simultaneously
    const finalCfg: FtmoDaytrade24hConfig = {
      ...cur,
      assets: cur.assets.map((a) => {
        const sym = a.sourceSymbol ?? "";
        const t = tunedRR[sym];
        return t ? { ...a, stopPct: t.sp, tpPct: t.tp } : a;
      }),
    };
    const finalR = runWalkForward(data, finalCfg, TF_HOURS);

    console.log(`\n========== PHASE A.1 FINAL ==========`);
    console.log(fmt("V1 baseline (uniform)", baseR));
    console.log(fmt("V1 + asym R:R", finalR));
    console.log(
      `Δ: +${((finalR.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${finalR.p90Days - baseR.p90Days}d p90`,
    );
    console.log(`\nPer-asset R:R:`);
    for (const [sym, rr] of Object.entries(tunedRR)) {
      console.log(
        `  ${sym}: stop=${rr.sp * 100}% tp=${rr.tp * 100}% (R:R=${(rr.tp / rr.sp).toFixed(2)})`,
      );
    }

    expect(finalR.windows).toBeGreaterThan(50);
  });
});
