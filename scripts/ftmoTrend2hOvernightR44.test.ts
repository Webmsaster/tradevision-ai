/**
 * R44 — alternative axes on V5_TITAN_REAL
 *
 * 44A: leverage sweep (current=2)
 * 44B: pyramid via virtual asset (existing pattern)
 * 44C: aggressive drawdown shield + dailyGainCap variants
 * 44D: maxConcurrentTrades reduce + adaptive size up
 * 44E: minTradingDays variation (3-6)
 * 44F: triggerBars per-asset heterogeneous tuning
 * 44G: more recent assets (XRP, TRX, ATOM with proper history check)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
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
const LOG_FILE = `${LOG_DIR}/R44_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
  "XRPUSDT",
  "TRXUSDT",
];

describe("R44 — alternative axes", { timeout: 24 * 3600_000 }, () => {
  it("runs R44", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R44 START ${new Date().toISOString()}\n`);

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
      return { mean, min, std, recent3, score: mean - 0.5 * std };
    }

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL);
    log(
      `Base V5_TITAN_REAL: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );

    const wins: any[] = [];
    function maybe(name: string, cfg: FtmoDaytrade24hConfig) {
      const r = evalCfg(cfg);
      const tag = r.score > baseR.score ? "🚀" : "·";
      log(
        `  ${tag} ${name.padEnd(45)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
      if (r.score > baseR.score) wins.push({ name, cfg, ...r });
    }

    // 44A: leverage sweep
    log(`\n========== 44A: leverage ==========`);
    for (const lev of [1, 1.5, 2, 2.5, 3]) {
      maybe(`leverage=${lev}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        leverage: lev,
      });
    }

    // 44B: pyramid (virtual asset)
    log(`\n========== 44B: pyramid (virtual asset) ==========`);
    function withPyramid(
      activateAfterDay: number,
      minEqGain: number,
    ): FtmoDaytrade24hConfig {
      const pyramidAssets: Daytrade24hAssetCfg[] =
        FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map((a) => ({
          ...a,
          symbol: a.symbol + "-PYR",
          sourceSymbol: a.sourceSymbol ?? a.symbol,
          activateAfterDay,
          minEquityGain: minEqGain,
        }));
      return {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        assets: [
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets,
          ...pyramidAssets,
        ],
      };
    }
    for (const day of [3, 5, 8]) {
      for (const eq of [0.02, 0.04, 0.06]) {
        maybe(`pyramid d=${day} eq=${eq}`, withPyramid(day, eq));
      }
    }

    // 44C: aggressive drawdown shield + dailyGainCap
    log(`\n========== 44C: drawdownShield + dailyGainCap ==========`);
    for (const ddBE of [-0.05, -0.03, -0.02, -0.01]) {
      for (const ddF of [0.3, 0.5, 0.7]) {
        maybe(`dd be=${ddBE} f=${ddF}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          drawdownShield: { belowEquity: ddBE, factor: ddF },
        });
      }
    }
    for (const cap of [0.02, 0.03, 0.05, 0.08]) {
      maybe(`dailyGain=${cap}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        dailyGainCap: cap,
      });
    }

    // 44D: maxConcurrent reduce
    log(`\n========== 44D: maxConcurrent + adaptive ==========`);
    for (const cap of [3, 4, 5, 6]) {
      maybe(`maxConcurrent=${cap}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        maxConcurrentTrades: cap,
      });
    }

    // 44E: minTradingDays
    log(`\n========== 44E: minTradingDays ==========`);
    for (const md of [3, 4, 5, 6]) {
      maybe(`minDays=${md}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        minTradingDays: md,
      });
    }

    // 44F: triggerBars per-asset
    log(`\n========== 44F: triggerBars per-asset (heterogeneous) ==========`);
    for (const ethTb of [1, 2]) {
      for (const btcTb of [1, 2]) {
        for (const altTb of [1, 2]) {
          if (ethTb === 1 && btcTb === 1 && altTb === 1) continue; // = baseline
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map(
              (a) => {
                if (a.symbol === "ETH-TREND")
                  return { ...a, triggerBars: ethTb };
                if (a.symbol === "BTC-TREND")
                  return { ...a, triggerBars: btcTb };
                return { ...a, triggerBars: altTb };
              },
            ),
          };
          maybe(`tb ETH=${ethTb} BTC=${btcTb} alts=${altTb}`, cfg);
        }
      }
    }

    // 44G: add XRP/TRX/ATOM (long-history alts not yet in V5_TITAN_REAL)
    log(`\n========== 44G: add long-history alts ==========`);
    function buildTrendAsset(s: string): Daytrade24hAssetCfg {
      return {
        symbol: `${s.replace("USDT", "")}-TREND`,
        sourceSymbol: s,
        costBp: 30,
        slippageBp: 8,
        swapBpPerDay: 4,
        riskFrac: 1.0,
        triggerBars: 1,
        invertDirection: true,
        disableShort: true,
        stopPct: 0.05,
        tpPct: 0.07,
        holdBars: 240,
        volTargeting: {
          period: 24,
          targetAtrFrac: 0.035,
          minMult: 0.5,
          maxMult: 1.5,
        },
      };
    }
    for (const sym of ["XRPUSDT", "TRXUSDT"]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        assets: [
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets,
          buildTrendAsset(sym),
        ],
      };
      maybe(`+${sym}`, cfg);
    }
    // Both
    {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        assets: [
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets,
          buildTrendAsset("XRPUSDT"),
          buildTrendAsset("TRXUSDT"),
        ],
      };
      maybe(`+XRP+TRX`, cfg);
    }

    log(`\n========== R44 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`Top 10:`);
      for (const w of wins.slice(0, 10)) {
        log(
          `  ${w.name.padEnd(45)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R44_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
