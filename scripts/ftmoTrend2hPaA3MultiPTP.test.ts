/**
 * Phase A.3: Multi-Level Partial TP sweep on TREND_2H_V1.
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

describe("Phase A.3 Multi-Level Partial TP", { timeout: 1800_000 }, () => {
  it("sweeps PTP level configs", async () => {
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
    };
    const baseR = runWalkForward(data, cur, TF_HOURS);
    console.log(fmt("V1 BASELINE", baseR));

    let best = { cfg: cur, r: baseR, label: "off" };
    const variants = [
      {
        label: "2 lvl 2%/4%",
        lvls: [
          { triggerPct: 0.02, closeFraction: 0.5 },
          { triggerPct: 0.04, closeFraction: 0.5 },
        ],
      },
      {
        label: "3 lvl 1.5/3/5%",
        lvls: [
          { triggerPct: 0.015, closeFraction: 0.33 },
          { triggerPct: 0.03, closeFraction: 0.33 },
          { triggerPct: 0.05, closeFraction: 0.34 },
        ],
      },
      {
        label: "3 lvl 2/4/6%",
        lvls: [
          { triggerPct: 0.02, closeFraction: 0.33 },
          { triggerPct: 0.04, closeFraction: 0.33 },
          { triggerPct: 0.06, closeFraction: 0.34 },
        ],
      },
      {
        label: "2 lvl 3/5%",
        lvls: [
          { triggerPct: 0.03, closeFraction: 0.5 },
          { triggerPct: 0.05, closeFraction: 0.5 },
        ],
      },
      {
        label: "2 lvl 1/3% conservative",
        lvls: [
          { triggerPct: 0.01, closeFraction: 0.5 },
          { triggerPct: 0.03, closeFraction: 0.5 },
        ],
      },
      {
        label: "small early + large late",
        lvls: [
          { triggerPct: 0.015, closeFraction: 0.25 },
          { triggerPct: 0.04, closeFraction: 0.5 },
        ],
      },
    ];
    for (const v of variants) {
      const cfg = {
        ...cur,
        partialTakeProfitLevels: v.lvls,
        partialTakeProfit: undefined,
      };
      const r = runWalkForward(data, cfg, TF_HOURS);
      console.log(fmt(`  ${v.label}`, r));
      if (score(r, best.r) < 0) best = { cfg, r, label: v.label };
    }
    console.log(`\n========== PHASE A.3 FINAL ==========`);
    console.log(fmt("V1 baseline", baseR));
    console.log(fmt(`PTP-multi winner (${best.label})`, best.r));
    console.log(
      `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp pass, ${best.r.p90Days - baseR.p90Days}d p90`,
    );
    expect(best.r.windows).toBeGreaterThan(50);
  });
});
