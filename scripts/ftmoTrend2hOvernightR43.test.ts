/**
 * R43 — TWO-DIRECTION strategy: longs in BTC-up + shorts in BTC-down
 *
 * Bisher V5_TITAN_REAL = nur longs. Idea: für jedes Asset zusätzlich virtuelle
 * SHORT-version (sourceSymbol same) mit:
 *   - disableLong=true, invertDirection=false (so trigger = N consecutive RED → SHORT)
 *   - crossAssetFilter requires BTC DOWNtrend
 *
 * → Doubles signals while diversifying directional risk.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
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
const LOG_FILE = `${LOG_DIR}/R43_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R43 — two-direction longs+shorts", { timeout: 24 * 3600_000 }, () => {
  it("runs R43", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R43 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL);
    log(
      `V5_TITAN_REAL base: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );

    // Build virtual SHORT-version for each existing asset
    function buildShortAsset(
      longAsset: Daytrade24hAssetCfg,
    ): Daytrade24hAssetCfg {
      return {
        ...longAsset,
        symbol: longAsset.symbol.replace("-TREND", "-TREND-SHORT"),
        sourceSymbol: longAsset.sourceSymbol,
        invertDirection: false,
        // when invertDirection=false, default behavior is consecutive-greens=long, reds=short
        // by setting disableLong=true, only shorts fire
        disableLong: true,
        disableShort: false,
        // turn off vol targeting? maybe lighter risk on shorts since less reliable
        riskFrac: longAsset.riskFrac,
      };
    }

    function withShorts(
      longCfg: FtmoDaytrade24hConfig,
      riskMultShort = 1.0,
    ): FtmoDaytrade24hConfig {
      const shortAssets = longCfg.assets.map((a) => ({
        ...buildShortAsset(a),
        riskFrac: a.riskFrac * riskMultShort,
      }));
      return { ...longCfg, assets: [...longCfg.assets, ...shortAssets] };
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

    // 43A: simple add shorts (no special filter)
    log(`\n========== 43A: longs + shorts (mirror) ==========`);
    for (const rm of [0.5, 0.7, 1.0]) {
      maybe(
        `+shorts riskMult=${rm}`,
        withShorts(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL, rm),
        wins,
      );
    }

    // 43B: shorts with BTC-DOWN cross-asset filter
    log(`\n========== 43B: shorts only when BTC down ==========`);
    function withFilteredShorts(
      longCfg: FtmoDaytrade24hConfig,
      btcFastP: number,
      btcSlowP: number,
      rm: number,
    ): FtmoDaytrade24hConfig {
      const shortAssets = longCfg.assets.map((a) => {
        const sa = buildShortAsset(a);
        sa.riskFrac = a.riskFrac * rm;
        return sa;
      });
      return {
        ...longCfg,
        assets: [...longCfg.assets, ...shortAssets],
        // override CAF to handle both directions
        crossAssetFilter: {
          symbol: "BTCUSDT",
          emaFastPeriod: btcFastP,
          emaSlowPeriod: btcSlowP,
          skipLongsIfSecondaryDowntrend: false, // longs don't need BTC up
          skipShortsIfSecondaryUptrend: true, // shorts only when BTC NOT up
        },
      };
    }
    for (const fp of [4, 8, 12]) {
      for (const sp of [12, 24, 48]) {
        if (sp <= fp) continue;
        for (const rm of [0.5, 0.7, 1.0]) {
          maybe(
            `shorts+BTC ${fp}/${sp} rm=${rm}`,
            withFilteredShorts(
              FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
              fp,
              sp,
              rm,
            ),
            wins,
          );
        }
      }
    }

    // 43C: ONLY shorts (drop longs entirely — sanity check)
    log(`\n========== 43C: shorts-only (sanity) ==========`);
    {
      const onlyShorts: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map(
          (a) => buildShortAsset(a),
        ),
      };
      maybe(`shorts-only (no longs)`, onlyShorts, wins);
    }

    // 43D: longs + shorts on V5 baseline (without all the trend-only filters)
    log(`\n========== 43D: V5 baseline + shorts ==========`);
    for (const rm of [0.5, 0.7, 1.0]) {
      maybe(
        `V5 + shorts rm=${rm}`,
        withShorts(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5, rm),
        wins,
      );
    }

    log(`\n========== R43 SUMMARY ==========`);
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
        `${LOG_DIR}/R43_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
