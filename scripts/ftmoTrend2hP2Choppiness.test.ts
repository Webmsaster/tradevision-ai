/**
 * Phase 2: Choppiness Index filter sweep on TREND_2H_V2.
 * CI > 61.8 = sideways, < 38.2 = trending. Skip choppy markets.
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

describe("Phase 2: Choppiness Index", { timeout: 1800_000 }, () => {
  it("sweeps choppinessFilter parameters", async () => {
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

    const cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V2,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V2 BASELINE (no CI)", baseR));

    console.log(`\n--- Choppiness Filter (max only — skip choppy) ---`);
    let best = { cfg: cur, r: baseR, label: "baseline" };
    for (const period of [10, 14, 20, 28]) {
      for (const maxCi of [38.2, 45, 50, 55, 61.8, 70]) {
        const cfg = { ...cur, choppinessFilter: { period, maxCi } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, best.r) < 0) {
          best = { cfg, r, label: `p${period} maxCi=${maxCi}` };
          console.log(fmt(`  CI ${best.label}`, r));
        }
      }
    }

    // Also try CI as a TRENDING-only filter (require CI < threshold)
    console.log(`\n--- Choppiness Filter (combined max+min) ---`);
    for (const period of [14, 20]) {
      for (const minCi of [10, 20, 30]) {
        for (const maxCi of [50, 55, 61.8, 70]) {
          const cfg = { ...cur, choppinessFilter: { period, maxCi, minCi } };
          const r = runWalkForward(data, cfg, TF_HOURS);
          if (score(r, best.r) < 0) {
            best = { cfg, r, label: `p${period} CI∈[${minCi},${maxCi}]` };
            console.log(fmt(`  CI ${best.label}`, r));
          }
        }
      }
    }

    console.log(`\n========== PHASE 2 FINAL ==========`);
    console.log(fmt("V2 baseline    ", baseR));
    console.log(fmt("Phase 2 winner ", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    console.log(`Winner: ${best.label}`);
    if (best.cfg.choppinessFilter)
      console.log(`  ${JSON.stringify(best.cfg.choppinessFilter)}`);

    expect(best.r.windows).toBeGreaterThan(50);
  });
});
