/**
 * Phase D: Cross-Asset Momentum Ranking on V4.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { runWalkForward, fmt, LIVE_CAPS } from "./_aggressiveSweepHelper";
import type { Candle } from "../src/utils/indicators";

const TF_HOURS = 2;
const SOURCES = ["ETHUSDT", "BTCUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT"];

function score(a: any, b: any) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.p90Days - b.p90Days;
}

describe("Cross-Asset Momentum Ranking", { timeout: 1800_000 }, () => {
  it("sweeps lookbackBars × topN", async () => {
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
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V4,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V4 BASELINE (5 assets)", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    for (const lb of [12, 24, 48, 84, 168, 336]) {
      // 1d to 4w lookback at 2h
      for (const topN of [1, 2, 3, 4]) {
        if (topN >= 5) continue;
        const cfg = { ...cur, momentumRanking: { lookbackBars: lb, topN } };
        const r = runWalkForward(data, cfg, TF_HOURS);
        if (score(r, best.r) < 0) {
          best = {
            cfg,
            r,
            label: `lb=${lb} (${((lb * TF_HOURS) / 24).toFixed(1)}d) topN=${topN}`,
          };
          console.log(fmt(`  ${best.label}`, r));
        }
      }
    }
    console.log(`\n========== MOMENTUM RANKING FINAL ==========`);
    console.log(fmt("V4 baseline", baseR));
    console.log(fmt(`winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
