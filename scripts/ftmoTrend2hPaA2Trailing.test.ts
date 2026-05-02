/**
 * Phase A.2: Trailing Stop sweep on TREND_2H_V1.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
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

describe("Phase A.2 Trailing Stop", { timeout: 1800_000 }, () => {
  it("sweeps activatePct × trailPct", async () => {
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
    console.log(`Aligned: ${n} bars\n`);

    const cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1 BASELINE", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    for (const ap of [0.01, 0.015, 0.02, 0.03, 0.04, 0.05]) {
      for (const tp of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
        const cfg = { ...cur, trailingStop: { activatePct: ap, trailPct: tp } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, best.r) < 0) {
          best = { cfg, r, label: `act=${ap} trail=${tp}` };
          console.log(fmt(`  ${best.label}`, r));
        }
      }
    }
    console.log(`\n========== PHASE A.2 FINAL ==========`);
    console.log(fmt("V1 baseline", baseR));
    console.log(fmt(`Trailing winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
