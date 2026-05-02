/**
 * Phase B.4: Correlation Filter sweep on V1 + trailing baseline.
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

describe("Phase B.4 Correlation Filter", { timeout: 1800_000 }, () => {
  it("sweeps maxOpenSameDirection", async () => {
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
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
      liveCaps: LIVE_CAPS,
      trailingStop: { activatePct: 0.03, trailPct: 0.005 },
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1+trailing baseline", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    for (const cap of [1, 2, 3, 4, 5, 6, 7]) {
      const cfg = { ...cur, correlationFilter: { maxOpenSameDirection: cap } };
      const r = runWalkForward(data, cfg, TF_HOURS);
      console.log(fmt(`  maxSameDir=${cap}`, r));
      if (score(r, best.r) < 0) best = { cfg, r, label: `cap=${cap}` };
    }
    console.log(`\n========== B.4 FINAL ==========`);
    console.log(fmt("baseline", baseR));
    console.log(fmt(`winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
