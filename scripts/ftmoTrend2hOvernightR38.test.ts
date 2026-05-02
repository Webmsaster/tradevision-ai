/**
 * R38 — drop-AVAX confirmed; greedy drop more + combine with ETH funding
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
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
const LOG_FILE = `${LOG_DIR}/R38_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R38 — drop AVAX + combine", { timeout: 24 * 3600_000 }, () => {
  it("runs R38", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R38 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX);
    log(
      `V5_APEX: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );

    function dropAssets(syms: string[]): FtmoDaytrade24hConfig {
      return {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.filter(
          (a) => !syms.includes(a.symbol),
        ),
      };
    }

    function withETHFund(maxFL: number): FtmoDaytrade24hConfig {
      return {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map((a) =>
          a.symbol === "ETH-TREND" ? { ...a, maxFundingForLong: maxFL } : a,
        ),
      };
    }

    function dropAndETH(syms: string[], maxFL: number): FtmoDaytrade24hConfig {
      return {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets
          .filter((a) => !syms.includes(a.symbol))
          .map((a) =>
            a.symbol === "ETH-TREND" ? { ...a, maxFundingForLong: maxFL } : a,
          ),
      };
    }

    function maybe(name: string, cfg: FtmoDaytrade24hConfig, results: any[]) {
      const r = evalCfg(cfg);
      const tag = r.score > baseR.score ? "🚀" : "·";
      log(
        `  ${tag} ${name.padEnd(45)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
      if (r.score > baseR.score) results.push({ name, cfg, ...r });
    }

    const wins: any[] = [];

    // Single-asset drops
    log(`\n========== Single drops ==========`);
    maybe(`drop AVAX`, dropAssets(["AVAX-TREND"]), wins);
    maybe(`drop DOGE`, dropAssets(["DOGE-TREND"]), wins);
    maybe(`drop AVAX + DOGE`, dropAssets(["AVAX-TREND", "DOGE-TREND"]), wins);

    // Greedy continued — drop one more after AVAX
    log(`\n========== Greedy continue (drop AVAX + one more) ==========`);
    for (const sym of [
      "BTC-TREND",
      "BNB-TREND",
      "ADA-TREND",
      "DOGE-TREND",
      "LTC-TREND",
      "BCH-TREND",
      "LINK-TREND",
    ]) {
      maybe(`drop AVAX + ${sym}`, dropAssets(["AVAX-TREND", sym]), wins);
    }

    // Combine drop AVAX + ETH funding
    log(`\n========== drop AVAX + ETH funding ==========`);
    for (const eth of [0.0005, 0.0008, 0.0012, 0.0015, 0.002]) {
      maybe(`drop AVAX + ETH=${eth}`, dropAndETH(["AVAX-TREND"], eth), wins);
    }

    // Combine drop AVAX + DOGE + ETH funding
    log(`\n========== drop AVAX+DOGE + ETH funding ==========`);
    for (const eth of [0.0005, 0.0008, 0.0012, 0.0015]) {
      maybe(
        `drop AVAX+DOGE + ETH=${eth}`,
        dropAndETH(["AVAX-TREND", "DOGE-TREND"], eth),
        wins,
      );
    }

    // Triple drop variants
    log(`\n========== Triple drops ==========`);
    for (const trio of [
      ["AVAX-TREND", "DOGE-TREND", "ADA-TREND"],
      ["AVAX-TREND", "DOGE-TREND", "BCH-TREND"],
      ["AVAX-TREND", "DOGE-TREND", "LTC-TREND"],
      ["AVAX-TREND", "DOGE-TREND", "LINK-TREND"],
      ["AVAX-TREND", "DOGE-TREND", "BNB-TREND"],
    ]) {
      maybe(`drop ${trio.join("+")}`, dropAssets(trio), wins);
    }

    // Re-tune volTgt after dropping AVAX
    log(`\n========== Drop AVAX + volTgt re-tune ==========`);
    for (const tgt of [0.025, 0.03, 0.035, 0.04]) {
      for (const mult of [2, 3, 5]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets
            .filter((a) => a.symbol !== "AVAX-TREND")
            .map((a) => ({
              ...a,
              volTargeting: {
                period: 24,
                targetAtrFrac: tgt,
                minMult: 0.5,
                maxMult: mult,
              },
            })),
        };
        maybe(`drop AVAX + volTgt ${tgt}/${mult}`, cfg, wins);
      }
    }

    log(`\n========== R38 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`\nTop 10:`);
      for (const w of wins.slice(0, 10)) {
        log(
          `  ${w.name.padEnd(45)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R38_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
