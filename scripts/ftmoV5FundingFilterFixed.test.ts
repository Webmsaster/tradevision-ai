/**
 * V5 + funding-rate filter — KORREKT mit fundingBySymbol param.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/V5_FUNDING_FIXED_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}
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
const LIVE_CAPS = { maxStopPct: 0.05, maxRiskFrac: 0.4 };

describe(
  "V5 with Funding (fixed param passing)",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(
        LOG_FILE,
        `V5_FUNDING_FIXED START ${new Date().toISOString()}\n`,
      );

      log("Loading candles + funding rates...");
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

      log("Loading funding rates aligned to aligned candles...");
      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const startMs = data[s][0].openTime;
        const endMs = data[s][data[s].length - 1].closeTime;
        try {
          const rows = await loadBinanceFundingRate(s, startMs, endMs);
          fundingBySymbol[s] = alignFundingToCandles(
            rows,
            data[s].map((c) => c.openTime),
          );
          const valid = fundingBySymbol[s].filter(
            (v) => v !== null && v !== undefined,
          ).length;
          log(
            `  ${s}: ${rows.length} funding rows → ${valid}/${data[s].length} aligned`,
          );
        } catch (e) {
          log(`  ${s}: funding load failed`);
          fundingBySymbol[s] = data[s].map(() => null);
        }
      }
      log("");

      function evalCfg(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
        const winBars = 30 * BARS_PER_DAY;
        const stepBars = 3 * BARS_PER_DAY;
        let p = 0,
          w = 0,
          tl = 0;
        for (let s = 0; s + winBars <= n; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          const subFunding: Record<string, (number | null)[]> = {};
          for (const sym of SOURCES) {
            sub[sym] = data[sym].slice(s, s + winBars);
            if (useFunding)
              subFunding[sym] = fundingBySymbol[sym].slice(s, s + winBars);
          }
          const r = runFtmoDaytrade24h(
            sub,
            cfg,
            useFunding ? subFunding : undefined,
          );
          if (r.passed) p++;
          if (r.reason === "total_loss") tl++;
          w++;
        }
        return { passRate: p / w, tlRate: tl / w, p, w };
      }

      const V5_BASE: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
        liveCaps: LIVE_CAPS,
      };
      const base = evalCfg(V5_BASE, false);
      log(
        `V5 baseline (no funding): ${(base.passRate * 100).toFixed(2)}% (${base.p}/${base.w}) TL=${(base.tlRate * 100).toFixed(2)}%`,
      );
      const baseWithFunding = evalCfg(V5_BASE, true);
      log(
        `V5 baseline (with funding, no filter): ${(baseWithFunding.passRate * 100).toFixed(2)}% — should be same\n`,
      );

      function test(name: string, mod: Partial<FtmoDaytrade24hConfig>) {
        const cfg: FtmoDaytrade24hConfig = { ...V5_BASE, ...mod };
        const r = evalCfg(cfg, true);
        const Δ = (r.passRate - base.passRate) * 100;
        const tag = Δ >= 1.0 ? "🚀" : Δ >= 0.3 ? "✅" : Δ <= -0.3 ? "❌" : "·";
        log(
          `  ${tag} ${name.padEnd(60)} pass=${(r.passRate * 100).toFixed(2)}% Δ=${Δ.toFixed(2)}pp TL=${(r.tlRate * 100).toFixed(2)}%`,
        );
      }

      log(`========== Funding Rate Filter — proper integration ==========`);
      log(
        `(Funding settles 8h, so values are typically ~0.0001 = 0.01% / 8h, normal range)\n`,
      );
      for (const maxFL of [
        0.00005, 0.0001, 0.0002, 0.0003, 0.0005, 0.001, 0.002,
      ]) {
        test(`maxFundingForLong=${maxFL}`, {
          fundingRateFilter: { maxFundingForLong: maxFL },
        } as any);
      }

      log(`\n========== With short rate constraint too ==========`);
      for (const minFS of [-0.001, -0.0005, -0.0002, -0.0001]) {
        test(`minFundingForShort=${minFS}`, {
          fundingRateFilter: { minFundingForShort: minFS },
        } as any);
      }

      log(`\n========== Combined: max long + min short ==========`);
      test("maxFL=0.0001 minFS=-0.0001", {
        fundingRateFilter: {
          maxFundingForLong: 0.0001,
          minFundingForShort: -0.0001,
        },
      } as any);
      test("maxFL=0.0003 minFS=-0.0003", {
        fundingRateFilter: {
          maxFundingForLong: 0.0003,
          minFundingForShort: -0.0003,
        },
      } as any);

      expect(true).toBe(true);
    });
  },
);
