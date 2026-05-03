/**
 * R37 — even more axes on V5_APEX
 *
 * 37A: timeExit (close dead trades after N bars without gain)
 * 37B: kellySizing (rolling win-rate based sizing)
 * 37C: alternative entries (donchian, tsMomentum, NR7)
 * 37D: per-asset minMult tuning (vol target lower bound)
 * 37E: stricter HTF + APEX
 * 37F: BNB extra CAF + APEX
 * 37G: smaller asset universe (drop weak performers)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
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
const LOG_FILE = `${LOG_DIR}/R37_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R37 — more axes on V5_APEX", { timeout: 24 * 3600_000 }, () => {
  it("runs R37", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R37 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX);
    log(
      `V5_APEX base: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );

    function maybeWin(
      name: string,
      cfg: FtmoDaytrade24hConfig,
      results: any[],
    ) {
      const r = evalCfg(cfg);
      const tag = r.score > baseR.score ? "🚀" : "·";
      log(
        `  ${tag} ${name.padEnd(45)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
      );
      if (r.score > baseR.score) results.push({ name, cfg, ...r });
    }

    const wins: any[] = [];

    // 37A: timeExit (close after N bars without gain)
    log(`\n========== 37A: timeExit ==========`);
    for (const maxBars of [12, 24, 48, 72, 120]) {
      for (const minGainR of [0.5, 1.0]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map((a) => ({
            ...a,
            timeExit: { maxBarsWithoutGain: maxBars, minGainR },
          })),
        };
        maybeWin(`timeExit ${maxBars}/${minGainR}`, cfg, wins);
      }
    }

    // 37B: kellySizing (with reasonable defaults)
    log(`\n========== 37B: kellySizing ==========`);
    for (const minTrades of [10, 20, 30]) {
      for (const windowSize of [20, 50, 100]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
          kellySizing: {
            minTrades,
            windowSize,
            tiers: [
              { winRateAbove: 0.55, multiplier: 1.5 },
              { winRateAbove: 0.45, multiplier: 1.0 },
              { winRateAbove: 0.0, multiplier: 0.5 },
            ],
          },
        };
        maybeWin(`kelly min=${minTrades} lb=${windowSize}`, cfg, wins);
      }
    }

    // 37C: alternative entries — donchian on top assets
    log(`\n========== 37C: donchianEntry per asset ==========`);
    for (const period of [10, 20, 50]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map((a) => ({
          ...a,
          donchianEntry: { period },
        })),
      };
      maybeWin(`donchian p=${period}`, cfg, wins);
    }

    // 37D: per-asset minMult tuning on vol target
    log(`\n========== 37D: vol-target minMult tuning ==========`);
    for (const minMult of [0.2, 0.3, 0.5, 0.7]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map((a) => ({
          ...a,
          volTargeting: {
            period: 24,
            targetAtrFrac: 0.03,
            minMult,
            maxMult: 3,
          },
        })),
      };
      maybeWin(`volTgt minMult=${minMult}`, cfg, wins);
    }

    // 37E: stricter HTF threshold on APEX
    log(`\n========== 37E: HTF threshold sweep ==========`);
    for (const thr of [-0.05, -0.02, 0, 0.02, 0.05, 0.08]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        htfTrendFilter: { lookbackBars: 48, apply: "long", threshold: thr },
      };
      maybeWin(`HTF lb=48 thr=${thr}`, cfg, wins);
    }

    // 37F: BTC funding stricter (most sensitive asset)
    log(`\n========== 37F: per-asset funding ==========`);
    for (const ethMax of [0.0005, 0.0008, 0.0015]) {
      for (const dogeMax of [0.001, 0.002, 0.003]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map((a) => {
            if (a.symbol === "ETH-TREND")
              return { ...a, maxFundingForLong: ethMax };
            if (a.symbol === "DOGE-TREND")
              return { ...a, maxFundingForLong: dogeMax };
            return a;
          }),
        };
        maybeWin(`ETH=${ethMax} DOGE=${dogeMax}`, cfg, wins);
      }
    }

    // 37G: drop one asset at a time
    log(`\n========== 37G: drop each asset ==========`);
    for (const sym of FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.map(
      (a) => a.symbol,
    )) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX.assets.filter(
          (a) => a.symbol !== sym,
        ),
      };
      maybeWin(`drop ${sym}`, cfg, wins);
    }

    // 37H: maxConcurrent sweep
    log(`\n========== 37H: maxConcurrentTrades ==========`);
    for (const cap of [3, 4, 5, 6, 7, 8, 9]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_APEX,
        maxConcurrentTrades: cap,
      };
      maybeWin(`maxConcurrent=${cap}`, cfg, wins);
    }

    log(`\n========== R37 SUMMARY ==========`);
    log(`Baseline V5_APEX: score=${(baseR.score * 100).toFixed(2)}%`);
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
        `${LOG_DIR}/R37_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
