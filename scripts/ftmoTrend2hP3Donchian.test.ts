/**
 * Phase 3: Donchian Channel Breakout as alternative entry signal.
 * Replaces N-green-closes trigger with classical breakout logic.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
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

describe("Phase 3: Donchian Breakout", { timeout: 1800_000 }, () => {
  it("sweeps Donchian period as entry trigger", async () => {
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
    console.log(fmt("V2 BASELINE (N-green entry)", baseR));

    console.log(`\n--- Donchian period sweep ---`);
    let best = { cfg: baseCfg, r: baseR, label: "n-green" };
    for (const period of [10, 14, 20, 28, 50, 100, 200]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...baseCfg,
        assets: baseCfg.assets.map((a) => ({
          ...a,
          donchianEntry: { period },
        })),
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      console.log(fmt(`  donchian p=${period}`, r));
      if (score(r, best.r) < 0) {
        best = { cfg, r, label: `donchian p=${period}` };
      }
    }

    // Try Donchian + various R:R
    console.log(`\n--- Donchian × R:R fine-grain ---`);
    if (best.label !== "n-green") {
      const best_p = parseInt(best.label.match(/p=(\d+)/)![1]);
      for (const sp of [0.025, 0.04, 0.05]) {
        for (const tp of [0.05, 0.07, 0.1]) {
          if (tp <= sp) continue;
          const cfg = {
            ...baseCfg,
            assets: baseCfg.assets.map((a) => ({
              ...a,
              donchianEntry: { period: best_p },
              stopPct: sp,
              tpPct: tp,
            })),
          };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, best.r) < 0) {
            best = { cfg, r, label: `donchian p=${best_p} sp=${sp} tp=${tp}` };
            console.log(fmt(`  ${best.label}`, r));
          }
        }
      }
    }

    console.log(`\n========== PHASE 3 FINAL ==========`);
    console.log(fmt("V2 baseline (n-green)", baseR));
    console.log(fmt("Phase 3 winner", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    console.log(`Winner: ${best.label}`);

    expect(best.r.windows).toBeGreaterThan(50);
  });
});
