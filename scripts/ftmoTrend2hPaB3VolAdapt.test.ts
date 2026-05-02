/**
 * Phase B.3: Vol-adaptive R:R sweep on V3 baseline (V1 + trail + hours).
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
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

describe("Phase B.3 Vol-Adaptive R:R", { timeout: 1800_000 }, () => {
  it("sweeps volAdaptiveRR parameters", async () => {
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
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V3,
      liveCaps: LIVE_CAPS,
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V3 BASELINE", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    for (const period of [14, 28, 50]) {
      for (const target of [0.005, 0.01, 0.02, 0.03]) {
        for (const minM of [0.5, 0.75, 1.0]) {
          for (const maxM of [1.0, 1.5, 2.0]) {
            if (maxM <= minM) continue;
            const cfg = {
              ...cur,
              volAdaptiveRR: {
                period,
                targetVolFrac: target,
                minMult: minM,
                maxMult: maxM,
              },
            };
            const r = runWalkForward(data, cfg, TF_HOURS);
            if (score(r, best.r) < 0) {
              best = {
                cfg,
                r,
                label: `p${period} tgt=${target} [${minM},${maxM}]`,
              };
              console.log(fmt(`  ${best.label}`, r));
            }
          }
        }
      }
    }
    console.log(`\n========== B.3 FINAL ==========`);
    console.log(fmt("V3 baseline", baseR));
    console.log(fmt(`winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
