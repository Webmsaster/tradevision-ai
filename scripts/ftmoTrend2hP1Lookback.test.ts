/**
 * Phase 1: extended HTF lookback sweep on TREND_2H_V2.
 * Academic optimum for Bitcoin trend-following: 125-230 days = 1500-2760 bars on 2h.
 * Currently at lookback=24 (= 48h). Test full academic range.
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

describe("Phase 1: HTF Lookback extension", { timeout: 1800_000 }, () => {
  it("sweeps lookback 24 to 2760 bars (academic Bitcoin range)", async () => {
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
    console.log(fmt("V2 BASELINE (lb=24)", baseR));

    console.log(`\n--- Lookback × Threshold sweep ---`);
    let best = { cfg: cur, r: baseR };
    // Cover 12h to 230 days
    const lookbacks = [
      12, 24, 48, 96, 168, 336, 504, 720, 1080, 1500, 1800, 2200, 2760,
    ];
    const thresholds = [-0.05, 0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3];

    for (const lb of lookbacks) {
      for (const thr of thresholds) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          htfTrendFilter: { lookbackBars: lb, apply: "long", threshold: thr },
        };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, best.r) < 0) {
          best = { cfg, r };
          const days = ((lb * TF_HOURS) / 24).toFixed(0);
          console.log(fmt(`  lb=${lb} (${days}d) thr=${thr}`, r));
        }
      }
    }

    console.log(`\n========== PHASE 1 FINAL ==========`);
    console.log(fmt("V2 baseline    ", baseR));
    console.log(fmt("Phase 1 winner ", best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    if (best.cfg.htfTrendFilter) {
      console.log(`Final HTF: ${JSON.stringify(best.cfg.htfTrendFilter)}`);
    }

    expect(best.r.windows).toBeGreaterThan(50);
  });
});
