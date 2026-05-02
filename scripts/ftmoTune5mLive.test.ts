/**
 * 5m Live-Cap Tuning Sweep.
 *
 * 5m candles produce ~288 bars/day = 6× finer than 30m. Bar-count-related
 * parameters scale up: holdBars, lossStreakCooldown, htfTrendFilter,
 * chandelierExit. atrStop is swept to find the (period, mult) sweet spot.
 *
 * Base inherits V12_30M_OPT's filter stack with 6× scaled bar counts.
 */
import { describe, it, expect } from "vitest";
import {
  FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  type FtmoDaytrade24hConfig,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import { findBestLiveSafe } from "./_liveSafeSweepHelper";

// V12_30M_OPT extends V261_2H_OPT and uses these bar counts (at 30m TF):
//   holdBars: 1200 (= 600h = 25d)
//   atrStop: p84 m32 — to be re-swept
//   lossStreakCooldown: cd 200
//   htfTrendFilter: lb 200, thr 0.08
//   chandelierExit: period 28
// For 5m TF (6× more bars/day):
//   holdBars: 7200 (= 25d)
//   lossStreakCooldown.cooldownBars: 1200 (was 200) — to be re-swept
//   htfTrendFilter.lookbackBars: 1200 (was 200) — to be re-swept
//   chandelierExit.period: 168 (was 28)
const V_5M_BASE: FtmoDaytrade24hConfig = {
  ...FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT,
  holdBars: 7200,
  lossStreakCooldown: { afterLosses: 2, cooldownBars: 1200 },
  htfTrendFilter: { lookbackBars: 1200, apply: "short", threshold: 0.08 },
  chandelierExit: {
    ...(FTMO_DAYTRADE_24H_CONFIG_V12_30M_OPT.chandelierExit ?? {
      period: 28,
      mult: 3,
      minMoveR: 0.5,
    }),
    period: 168,
  },
};

describe(
  "Live-safe 5m tuning (V12-derived 6×-scaled base)",
  { timeout: 1800_000 },
  () => {
    it("finds best 5m config under live caps", async () => {
      // 5m: 288 bars/day. SOL listing 2020-08 → ~5.7y max history.
      // 250k bars = 868 days = 2.38y at 5m — load max via paged backfill.
      const targetCount = 250000;
      const maxPages = 250;

      const eth = await loadBinanceHistory({
        symbol: "ETHUSDT",
        timeframe: "5m",
        targetCount,
        maxPages,
      });
      const btc = await loadBinanceHistory({
        symbol: "BTCUSDT",
        timeframe: "5m",
        targetCount,
        maxPages,
      });
      const sol = await loadBinanceHistory({
        symbol: "SOLUSDT",
        timeframe: "5m",
        targetCount,
        maxPages,
      });

      const n = Math.min(eth.length, btc.length, sol.length);
      const data = {
        ETHUSDT: eth.slice(-n),
        BTCUSDT: btc.slice(-n),
        SOLUSDT: sol.slice(-n),
      };
      const yrs = (n / 288 / 365).toFixed(2);
      console.log(`\n=== 5m Live-Safe Sweep — ${yrs}y / ${n} bars ===`);

      const { finalResult, label } = findBestLiveSafe(V_5M_BASE, data, 5 / 60);
      console.log(`\nLIVE_5M_V1 = ${label}`);
      console.log(
        `  pass=${(finalResult.passRate * 100).toFixed(2)}% med=${finalResult.medianDays}d p75=${finalResult.p75Days}d p90=${finalResult.p90Days}d EV=$${finalResult.ev.toFixed(0)}`,
      );
      expect(finalResult.passRate).toBeGreaterThanOrEqual(0);
    });
  },
);
