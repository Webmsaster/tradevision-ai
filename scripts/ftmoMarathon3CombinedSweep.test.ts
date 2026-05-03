/**
 * Marathon iteration 3: Combined fine-tune of trailing + hours + LSC + chand on V4.
 * Coordinated sweep, not isolated.
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

describe(
  "Marathon 3 - Combined Trail+Hours+Chand+LSC",
  { timeout: 1800_000 },
  () => {
    it("joint optimization of multiple axes", async () => {
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
      console.log(fmt("V4 BASELINE", baseR));

      // Joint fine-tune: trailing + chand + lsc
      let best = { cfg: cur, r: baseR, label: "current" };
      let count = 0;
      for (const trAct of [0.02, 0.03, 0.04]) {
        for (const trPct of [0.003, 0.005, 0.008, 0.012]) {
          for (const chP of [14, 28, 56]) {
            for (const chM of [2, 3, 4]) {
              for (const lsc of [6, 12, 24, 48]) {
                count++;
                const cfg: FtmoDaytrade24hConfig = {
                  ...cur,
                  trailingStop: { activatePct: trAct, trailPct: trPct },
                  chandelierExit: { period: chP, mult: chM, minMoveR: 0.5 },
                  lossStreakCooldown: { afterLosses: 2, cooldownBars: lsc },
                };
                const r = runWalkForward(data, cfg, TF_HOURS);
                if (score(r, best.r) < 0) {
                  best = {
                    cfg,
                    r,
                    label: `tr(${trAct},${trPct}) ch(${chP},${chM}) lsc=${lsc}`,
                  };
                  console.log(fmt(`  [${count}] ${best.label}`, r));
                }
              }
            }
          }
        }
      }
      console.log(`Tested ${count} variants`);
      console.log(`\n========== M3 FINAL ==========`);
      console.log(fmt("V4 baseline", baseR));
      console.log(fmt(`Best (${best.label})`, best.r));
      console.log(
        `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );
      expect(best.r.windows).toBeGreaterThan(50);
    });
  },
);
