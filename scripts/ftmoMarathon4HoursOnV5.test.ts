/**
 * Marathon 4: Hour-drop on V5 (9 assets).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
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
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("Marathon 4 - V5 Hour-Drop", { timeout: 1800_000 }, () => {
  it("greedy hour drop on 9-asset V5", async () => {
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

    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
      liveCaps: LIVE_CAPS,
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V5 BASELINE", curR));

    let best = { cfg: cur, r: curR };
    let bestHours = cur.allowedHoursUtc ?? [
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22,
    ];
    let improved = true,
      iter = 0;
    while (improved && iter < 5) {
      improved = false;
      for (const h of [...bestHours]) {
        const cand = bestHours.filter((x) => x !== h);
        if (cand.length < 4) continue;
        const cfg = { ...cur, allowedHoursUtc: cand };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, best.r) < 0) {
          best = { cfg, r };
          bestHours = cand;
          improved = true;
          console.log(fmt(`  drop ${h}`, r));
        }
      }
      iter++;
    }
    console.log(`\n========== M4 FINAL ==========`);
    console.log(fmt("V5 baseline", curR));
    console.log(fmt("After hour-drop", best.r));
    console.log(`Final hours: ${bestHours.join(",")}`);
    console.log(
      `Δ: +${((best.r.passRate - curR.passRate) * 100).toFixed(2)}pp`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
