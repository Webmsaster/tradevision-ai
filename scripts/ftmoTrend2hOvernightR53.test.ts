/**
 * R53 — final exploration: per-asset tuning, regime switching, more configs on V5_PRIMEX
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
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
const LOG_FILE = `${LOG_DIR}/R53_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const SOURCES = [
  "ETHUSDT",
  "BTCUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

describe("R53 — final on V5_PRIMEX", { timeout: 24 * 3600_000 }, () => {
  it("runs R53", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R53 START ${new Date().toISOString()}\n`);

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
      const tlRates: number[] = [];
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      for (let si = 0; si < numSlices; si++) {
        let p = 0,
          w = 0,
          tl = 0;
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
          if (r.reason === "total_loss") tl++;
          w++;
        }
        rates.push(w > 0 ? p / w : 0);
        tlRates.push(w > 0 ? tl / w : 0);
      }
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const min = Math.min(...rates);
      const std = Math.sqrt(
        rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length,
      );
      const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const meanTL = tlRates.reduce((a, b) => a + b, 0) / tlRates.length;
      const score = mean - 0.5 * std - 2.0 * meanTL;
      return { mean, min, std, recent3, meanTL, score };
    }

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX);
    log(
      `V5_PRIMEX: mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}% TL=${(baseR.meanTL * 100).toFixed(2)}% score=${(baseR.score * 100).toFixed(2)}%`,
    );

    const wins: any[] = [];
    function maybe(name: string, cfg: FtmoDaytrade24hConfig) {
      const r = evalCfg(cfg);
      const tag = r.score > baseR.score ? "🚀" : "·";
      log(
        `  ${tag} ${name.padEnd(45)} mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
      );
      if (r.score > baseR.score) wins.push({ name, cfg, ...r });
    }

    // 53A: per-asset triggerBars
    log(`\n========== 53A: per-asset triggerBars ==========`);
    for (const a of FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets) {
      for (const tb of [2, 3]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, triggerBars: tb } : x,
          ),
        };
        maybe(`${a.symbol} tb=${tb}`, cfg);
      }
    }

    // 53B: maxConcurrentTrades sweep on PRIMEX (8 assets, current 6)
    log(`\n========== 53B: maxConcurrent ==========`);
    for (const cap of [3, 4, 5, 6, 7, 8]) {
      maybe(`maxConcurrent=${cap}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        maxConcurrentTrades: cap,
      });
    }

    // 53C: per-asset stopPct/tpPct
    log(`\n========== 53C: per-asset stop tighter (3.5/4/4.5) ==========`);
    for (const sp of [0.035, 0.04, 0.045]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        stopPct: sp,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) => ({
          ...a,
          stopPct: sp,
        })),
      };
      maybe(`stopPct=${sp}`, cfg);
    }

    // 53D: per-asset stop heterogeneous (BTC tighter 3.5%, alts default 5%)
    log(`\n========== 53D: BTC/ETH tighter stops ==========`);
    for (const tightSp of [0.03, 0.035, 0.04]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) =>
          a.symbol === "BTC-TREND" || a.symbol === "ETH-TREND"
            ? { ...a, stopPct: tightSp }
            : a,
        ),
      };
      maybe(`BTC+ETH stop=${tightSp}`, cfg);
    }

    // 53E: BTC tighter funding (BTC has tightest funding distribution)
    log(`\n========== 53E: per-asset funding (BTC tighter) ==========`);
    for (const btcMaxFL of [0.0003, 0.0005, 0.0007]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) =>
          a.symbol === "BTC-TREND" ? { ...a, maxFundingForLong: btcMaxFL } : a,
        ),
      };
      maybe(`BTC fund=${btcMaxFL}`, cfg);
    }

    // 53F: holdBars sweep (current 240 = 20 days)
    log(`\n========== 53F: holdBars ==========`);
    for (const hb of [120, 180, 240, 360, 480]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        holdBars: hb,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) => ({
          ...a,
          holdBars: hb,
        })),
      };
      maybe(`holdBars=${hb}`, cfg);
    }

    // 53G: hour set tighten
    log(`\n========== 53G: drop a hour ==========`);
    const baseHrs =
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.allowedHoursUtc!;
    for (const h of baseHrs) {
      maybe(`drop hr ${h}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        allowedHoursUtc: baseHrs.filter((x) => x !== h),
      });
    }

    log(`\n========== R53 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`Top 10:`);
      for (const w of wins.slice(0, 10)) {
        log(
          `  ${w.name.padEnd(45)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}% TL=${(w.meanTL * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R53_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
