import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
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

describe(
  "Marathon 8 - Global R:R + holdBars sweep V6",
  { timeout: 1800_000 },
  () => {
    it("joint sweep R:R + holdBars + triggerBars", async () => {
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
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V6,
        liveCaps: LIVE_CAPS,
      };
      const baseR = runWalkForward(data, cur, TF_HOURS);
      console.log(fmt("V6 BASELINE", baseR));

      let best = { cfg: cur, r: baseR, label: "current" };
      for (const tb of [1, 2]) {
        for (const sp of [0.035, 0.04, 0.045, 0.05]) {
          for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1]) {
            if (tp <= sp) continue;
            for (const hb of [120, 180, 240, 360, 480]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                triggerBars: tb,
                stopPct: sp,
                tpPct: tp,
                holdBars: hb,
                assets: cur.assets.map((a) => ({
                  ...a,
                  triggerBars: tb,
                  stopPct: sp,
                  tpPct: tp,
                  holdBars: hb,
                })),
              };
              const r = runWalkForward(data, cfg, TF_HOURS);
              if (score(r, best.r) < 0) {
                best = { cfg, r, label: `tb=${tb} sp=${sp} tp=${tp} hb=${hb}` };
                console.log(fmt(`  ${best.label}`, r));
              }
            }
          }
        }
      }
      console.log(`\n========== M8 FINAL ==========`);
      console.log(fmt("V6 baseline", baseR));
      console.log(fmt(`Winner (${best.label})`, best.r));
      console.log(
        `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );
      expect(best.r.windows).toBeGreaterThan(50);
    });
  },
);
