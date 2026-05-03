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
  "Marathon 7 - Combined Trail+ChandTune V6",
  { timeout: 1800_000 },
  () => {
    it("joint sweep on V6", async () => {
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
      for (const trAct of [0.015, 0.02, 0.025, 0.03, 0.04]) {
        for (const trPct of [0.003, 0.005, 0.008, 0.012, 0.02]) {
          for (const chP of [0, 14, 28, 56, 84]) {
            for (const chM of [2, 3, 4]) {
              const cfg: FtmoDaytrade24hConfig = {
                ...cur,
                trailingStop: { activatePct: trAct, trailPct: trPct },
                chandelierExit:
                  chP > 0
                    ? { period: chP, mult: chM, minMoveR: 0.5 }
                    : undefined,
              };
              const r = runWalkForward(data, cfg, TF_HOURS);
              if (score(r, best.r) < 0) {
                best = {
                  cfg,
                  r,
                  label: `tr(${trAct},${trPct}) ch=${chP > 0 ? `${chP}/${chM}` : "off"}`,
                };
                console.log(fmt(`  ${best.label}`, r));
              }
            }
          }
        }
      }
      console.log(`\n========== M7 FINAL ==========`);
      console.log(fmt("V6 baseline", baseR));
      console.log(fmt(`Winner (${best.label})`, best.r));
      console.log(
        `Δ: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
      );
      expect(best.r.windows).toBeGreaterThan(50);
    });
  },
);
