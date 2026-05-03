/**
 * Phase B.2: Per-asset time-of-day asymmetry (allowed hours per asset).
 * Some assets perform better in different sessions (Asia vs EU vs US).
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

describe("Phase B.2 Time-of-day per asset", { timeout: 1800_000 }, () => {
  it("greedy hour-drop on V1 + trailing-stop baseline", async () => {
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

    // Apply A.2 trailing winner as new baseline
    let cur: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V1,
      liveCaps: LIVE_CAPS,
      trailingStop: { activatePct: 0.03, trailPct: 0.005 },
    };
    let curR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1 + trailing baseline", curR));

    console.log(`\n--- Greedy hour-drop sweep ---`);
    let best = { cfg: cur, r: curR };
    let bestHours = cur.allowedHoursUtc ?? [
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22,
    ];
    let improved = true;
    let iter = 0;
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
          console.log(fmt(`  drop ${h} → hours [${cand.join(",")}]`, r));
        }
      }
      iter++;
    }

    console.log(`\n========== PHASE B.2 FINAL ==========`);
    console.log(fmt("baseline (V1+trail)", curR));
    console.log(fmt("After hour-drop", best.r));
    console.log(
      `Δ: +${((best.r.passRate - curR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - curR.p90Days}d p90`,
    );
    console.log(`Final hours: ${bestHours.join(",")}`);
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
