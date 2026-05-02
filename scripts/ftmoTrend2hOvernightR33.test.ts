/**
 * R33 — final validation: V5_ULTRA (ADX + volumeFilter + funding) multi-fold OOS
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
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
const LOG_FILE = `${LOG_DIR}/R33_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R33 — final ULTRA validation", { timeout: 24 * 3600_000 }, () => {
  it("runs R33", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R33 START ${new Date().toISOString()}\n`);

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

    log(`Loading funding...`);
    const fundingBySymbol: Record<string, (number | null)[]> = {};
    for (const s of SOURCES) {
      const rows = await loadBinanceFundingRate(s, startMs, endMs);
      fundingBySymbol[s] = alignFundingToCandles(
        rows,
        data[s].map((c) => c.openTime),
      );
    }
    log(`Funding loaded for ${Object.keys(fundingBySymbol).length} symbols\n`);

    const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
    const numSlices = Math.floor(n / sixMo);

    function evalCfg(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
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
            if (useFunding)
              subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
          }
          const r = runFtmoDaytrade24h(
            sub,
            cfg,
            useFunding ? subFund : undefined,
          );
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
      return { rates, mean, min, std, recent3 };
    }

    const list = [
      { name: "V5", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, fund: false },
      {
        name: "V5_RECENT",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
        fund: false,
      },
      {
        name: "V5_ROBUST",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
        fund: false,
      },
      {
        name: "V5_PARETO",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PARETO,
        fund: false,
      },
      {
        name: "V5_FUND",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_FUND,
        fund: true,
      },
      {
        name: "V5_ULTRA",
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
        fund: true,
      },
    ];

    log(`========== Multi-fold OOS (11 slices) ==========`);
    log(
      `${"config".padEnd(15)} mean    min     std    recent3 score(=mean-0.5*std)`,
    );
    type Res = {
      name: string;
      mean: number;
      min: number;
      std: number;
      recent3: number;
    };
    const results: Res[] = [];
    for (const { name, cfg, fund } of list) {
      const r = evalCfg(cfg, fund);
      const score = r.mean - 0.5 * r.std;
      results.push({ name, ...r });
      log(
        `${name.padEnd(15)} ${(r.mean * 100).toFixed(2)}%  ${(r.min * 100).toFixed(2)}%  ${(r.std * 100).toFixed(2)}%  ${(r.recent3 * 100).toFixed(2)}%  ${(score * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== Per-slice rates ==========`);
    for (const r of results) {
      log(
        `${r.name.padEnd(15)} ${(r as any).rates.map((x: number) => `${(x * 100).toFixed(1).padStart(5)}%`).join(" ")}`,
      );
    }

    log(`\n========== Robustness ranking ==========`);
    results.sort((a, b) => b.mean - 0.5 * b.std - (a.mean - 0.5 * a.std));
    for (let i = 0; i < results.length; i++) {
      log(
        `  #${i + 1}: ${results[i].name.padEnd(15)} score=${((results[i].mean - 0.5 * results[i].std) * 100).toFixed(2)}%`,
      );
    }

    log(`\n========== Recent-3 ranking (live forecast) ==========`);
    results.sort((a, b) => b.recent3 - a.recent3);
    for (let i = 0; i < results.length; i++) {
      log(
        `  #${i + 1}: ${results[i].name.padEnd(15)} recent3=${(results[i].recent3 * 100).toFixed(2)}%`,
      );
    }

    expect(true).toBe(true);
  });
});
