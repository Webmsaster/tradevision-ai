/**
 * R42 — REALISTIC TEST: cap volTargeting maxMult ≤ 1.5 (cannot exceed live caps)
 *
 * Discovery: volTargeting volMult scales BOTH upside AND downside, breaking live caps.
 * With maxMult=8, a single stop can lose 8× the FTMO max-daily-loss.
 *
 * Re-test ALL champions with realistic maxMult bounds.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
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
const LOG_FILE = `${LOG_DIR}/R42_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

function capMaxMult(
  cfg: FtmoDaytrade24hConfig,
  cap: number,
): FtmoDaytrade24hConfig {
  return {
    ...cfg,
    assets: cfg.assets.map((a) =>
      a.volTargeting
        ? {
            ...a,
            volTargeting: {
              ...a.volTargeting,
              maxMult: Math.min(a.volTargeting.maxMult, cap),
            },
          }
        : a,
    ),
  };
}

describe(
  "R42 — REALISTIC test with maxMult cap",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R42", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R42 START ${new Date().toISOString()}\n`);

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
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs = data[SOURCES[0]][n - 1].openTime + 2 * 3600_000;

      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        fundingBySymbol[s] = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
      }

      const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
      const numSlices = Math.floor(n / sixMo);

      function evalCfg(cfg: FtmoDaytrade24hConfig) {
        const rates: number[] = [];
        const winBars = 30 * BARS_PER_DAY;
        const stepBars = 3 * BARS_PER_DAY;
        for (let si = 0; si < numSlices; si++) {
          let p = 0,
            w = 0;
          const sliceStart = si * sixMo;
          const sliceEnd = (si + 1) * sixMo;
          for (let s = sliceStart; s + winBars <= sliceEnd; s += stepBars) {
            const sub: Record<string, Candle[]> = {};
            const subFund: Record<string, (number | null)[]> = {};
            for (const sym of SOURCES) {
              sub[sym] = data[sym].slice(s, s + winBars);
              subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
            }
            const r = runFtmoDaytrade24h(sub, cfg, subFund);
            if (r.passed) p++;
            w++;
          }
          rates.push(w > 0 ? p / w : 0);
        }
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const min = Math.min(...rates);
        const std = Math.sqrt(
          rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length,
        );
        const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / 3;
        return { rates, mean, min, std, recent3, score: mean - 0.5 * std };
      }

      log(`========== ALL champions @ maxMult=1.5 (realistic) ==========`);
      log(
        `${"config".padEnd(15)} mean    min     std     recent3 score   notes`,
      );
      const order = [
        ["V5", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5],
        ["V5_ROBUST", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST],
        ["V5_RECENT", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT],
        ["V5_PARETO", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO],
        ["V5_FUND", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND],
        ["V5_ULTRA", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA],
        ["V5_ELITE", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE],
        ["V5_APEX", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX],
        ["V5_TITAN", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN],
        ["V5_LEGEND", FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND],
      ] as const;

      for (const [name, cfg] of order) {
        const original = evalCfg(cfg);
        const capped = evalCfg(capMaxMult(cfg, 1.5));
        log(
          `${name.padEnd(15)} original: mean=${(original.mean * 100).toFixed(2)}% min=${(original.min * 100).toFixed(2)}% recent3=${(original.recent3 * 100).toFixed(2)}% score=${(original.score * 100).toFixed(2)}%`,
        );
        log(
          `${" ".repeat(15)} maxMult≤1.5: mean=${(capped.mean * 100).toFixed(2)}% min=${(capped.min * 100).toFixed(2)}% recent3=${(capped.recent3 * 100).toFixed(2)}% score=${(capped.score * 100).toFixed(2)}%`,
        );
      }

      log(`\n========== Look for true winners @ maxMult=1.5 ==========`);
      // Sweep maxMult fine-grain on V5_LEGEND base
      for (const mult of [1.0, 1.2, 1.3, 1.5]) {
        for (const tgt of [0.025, 0.03, 0.035, 0.04, 0.05, 0.07, 0.1]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND.assets.map(
              (a) => ({
                ...a,
                volTargeting: {
                  period: 24,
                  targetAtrFrac: tgt,
                  minMult: 0.5,
                  maxMult: mult,
                },
              }),
            ),
          };
          const r = evalCfg(cfg);
          log(
            `  volTgt ${tgt}/${mult}                   mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
          );
        }
      }

      expect(true).toBe(true);
    });
  },
);
