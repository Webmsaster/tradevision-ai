/**
 * R40 — combine R39 wins: ADX 14/12 + volTgt 0.045/3 + TITAN base
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
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
const LOG_FILE = `${LOG_DIR}/R40_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R40 — combine R39 wins", { timeout: 24 * 3600_000 }, () => {
  it("runs R40", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R40 START ${new Date().toISOString()}\n`);

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

    function buildCfg(overrides: {
      adxP?: number;
      adxM?: number;
      volTgt?: number;
      volMult?: number;
    }): FtmoDaytrade24hConfig {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
      };
      if (overrides.adxP !== undefined && overrides.adxM !== undefined) {
        cfg.adxFilter = { period: overrides.adxP, minAdx: overrides.adxM };
      }
      if (overrides.volTgt !== undefined && overrides.volMult !== undefined) {
        cfg.assets = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN.assets.map(
          (a) => ({
            ...a,
            volTargeting: {
              period: 24,
              targetAtrFrac: overrides.volTgt!,
              minMult: 0.5,
              maxMult: overrides.volMult!,
            },
          }),
        );
      }
      return cfg;
    }

    const titanR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN);
    log(
      `TITAN base: score=${(titanR.score * 100).toFixed(2)}% mean=${(titanR.mean * 100).toFixed(2)}% min=${(titanR.min * 100).toFixed(2)}% recent3=${(titanR.recent3 * 100).toFixed(2)}%`,
    );

    const tests = [
      { name: "TITAN base", o: {} },
      { name: "ADX 14/12 only", o: { adxP: 14, adxM: 12 } },
      { name: "ADX 14/10 only", o: { adxP: 14, adxM: 10 } },
      { name: "volTgt 0.045/3 only", o: { volTgt: 0.045, volMult: 3 } },
      { name: "volTgt 0.05/3 only", o: { volTgt: 0.05, volMult: 3 } },
      {
        name: "ADX 14/12 + volTgt 0.045/3",
        o: { adxP: 14, adxM: 12, volTgt: 0.045, volMult: 3 },
      },
      {
        name: "ADX 14/12 + volTgt 0.05/3",
        o: { adxP: 14, adxM: 12, volTgt: 0.05, volMult: 3 },
      },
      {
        name: "ADX 14/15 + volTgt 0.045/3",
        o: { adxP: 14, adxM: 15, volTgt: 0.045, volMult: 3 },
      },
      {
        name: "ADX 14/10 + volTgt 0.045/3",
        o: { adxP: 14, adxM: 10, volTgt: 0.045, volMult: 3 },
      },
      {
        name: "ADX 14/18 + volTgt 0.045/3",
        o: { adxP: 14, adxM: 18, volTgt: 0.045, volMult: 3 },
      },
      {
        name: "ADX 14/12 + volTgt 0.04/3",
        o: { adxP: 14, adxM: 12, volTgt: 0.04, volMult: 3 },
      },
      {
        name: "ADX 14/12 + volTgt 0.035/5",
        o: { adxP: 14, adxM: 12, volTgt: 0.035, volMult: 5 },
      },
      {
        name: "ADX 14/12 + volTgt 0.05/5",
        o: { adxP: 14, adxM: 12, volTgt: 0.05, volMult: 5 },
      },
      // momRanking + ADX combo
      { name: "ADX 14/12 (no momRank)", o: { adxP: 14, adxM: 12 } }, // (placeholder; tweak below)
    ];

    const results: any[] = [];
    for (const t of tests) {
      const cfg = buildCfg(t.o);
      const r = evalCfg(cfg);
      const tag = r.score > titanR.score ? "🚀" : "·";
      log(
        `  ${tag} ${t.name.padEnd(40)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
      results.push({ name: t.name, cfg, ...r });
    }

    // Try without momRanking, ADX p=14/12
    log(`\n========== Try removing momRanking ==========`);
    const noMRcfg: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
      momentumRanking: undefined,
      adxFilter: { period: 14, minAdx: 12 },
    };
    const noMRr = evalCfg(noMRcfg);
    const tag = noMRr.score > titanR.score ? "🚀" : "·";
    log(
      `  ${tag} no momRank + ADX 14/12         score=${(noMRr.score * 100).toFixed(2)}% mean=${(noMRr.mean * 100).toFixed(2)}% min=${(noMRr.min * 100).toFixed(2)}% recent3=${(noMRr.recent3 * 100).toFixed(2)}%`,
    );
    if (noMRr.score > titanR.score)
      results.push({ name: "no momRank + ADX 14/12", cfg: noMRcfg, ...noMRr });

    // Reduce momRank topN
    for (const topN of [5, 6, 8]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
        momentumRanking: { lookbackBars: 12, topN },
        adxFilter: { period: 14, minAdx: 12 },
      };
      const r = evalCfg(cfg);
      const tag = r.score > titanR.score ? "🚀" : "·";
      log(
        `  ${tag} momRank top=${topN} + ADX 14/12     score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
      if (r.score > titanR.score)
        results.push({ name: `momRank top=${topN} + ADX 14/12`, cfg, ...r });
    }

    log(`\n========== R40 SUMMARY ==========`);
    log(`TITAN baseline: score=${(titanR.score * 100).toFixed(2)}%`);
    results.sort((a, b) => b.score - a.score);
    log(`Top 10:`);
    for (const r of results.slice(0, 10)) {
      log(
        `  ${r.name.padEnd(40)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
    }
    if (results[0].score > titanR.score) {
      writeFileSync(
        `${LOG_DIR}/R40_BEST.json`,
        JSON.stringify(results[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
