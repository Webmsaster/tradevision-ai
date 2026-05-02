/**
 * R54 — push toward 90%: ultra-wide Bayesian + theoretical ceiling test
 *
 * Phase 1: Test V5_PRIMEX WITHOUT liveCaps to find theoretical ceiling
 *   (NOT live-deployable! Just shows what's possible math-wise.)
 * Phase 2: 5000-trial mega search with TL-aware scoring on V5_PRIMEX
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R54_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

function pickv<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function maybe<T>(prob: number, get: () => T | undefined): T | undefined {
  return Math.random() < prob ? get() : undefined;
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

describe("R54 — push to 90%", { timeout: 24 * 3600_000 }, () => {
  it("runs R54", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R54 START ${new Date().toISOString()}\n`);

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

    log(
      `========== Phase 1: theoretical ceiling without liveCaps (NOT LIVE-USABLE) ==========`,
    );
    const noCaps: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
      liveCaps: undefined,
    };
    const noCapsR = evalCfg(noCaps);
    log(
      `V5_PRIMEX no-caps: mean=${(noCapsR.mean * 100).toFixed(2)}% min=${(noCapsR.min * 100).toFixed(2)}% recent3=${(noCapsR.recent3 * 100).toFixed(2)}% TL=${(noCapsR.meanTL * 100).toFixed(2)}%`,
    );
    log(`(THIS IS BACKTEST-ONLY — would breach FTMO daily-loss in live)`);

    log(
      `\n========== Phase 2: 5000-trial mega search WITH liveCaps (live-usable) ==========`,
    );
    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX);
    log(
      `V5_PRIMEX baseline: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}%`,
    );

    let best = {
      name: "PRIMEX",
      cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
      ...baseR,
    };

    for (let trial = 0; trial < 5000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 4 + Math.floor(Math.random() * 16);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        allowedHoursUtc: hours,
        adxFilter: {
          period: pickv([6, 8, 10, 14, 20, 28]),
          minAdx: pickv([0, 5, 8, 10, 12, 15, 20]),
        },
        htfTrendFilter: maybe(0.6, () => ({
          lookbackBars: pickv([12, 24, 48, 72, 120, 240]),
          apply: pickv(["long", "both"] as const),
          threshold: pickv([-0.05, 0, 0.02, 0.05, 0.1]),
        })),
        chandelierExit: maybe(0.7, () => ({
          period: pickv([14, 28, 56, 84, 168]),
          mult: pickv([1.5, 2, 2.5, 3, 4, 5]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.4, () => ({
          period: pickv([10, 14, 20, 28]),
          maxCi: pickv([55, 60, 65, 70, 75, 80]),
        })),
        lossStreakCooldown: maybe(0.5, () => ({
          afterLosses: pickv([2, 3, 4, 5]),
          cooldownBars: pickv([12, 24, 48, 72, 120]),
        })),
        crossAssetFilter: maybe(0.6, () => ({
          symbol: pickv(["BTCUSDT", "ETHUSDT"]),
          emaFastPeriod: pickv([4, 6, 8, 12]),
          emaSlowPeriod: pickv([12, 24, 36, 48, 96]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pickv([8, 12, 18, 24, 36, 48]),
          momSkipLongBelow: pickv([-0.08, -0.05, -0.03, -0.02, -0.01, 0]),
        })),
        crossAssetFiltersExtra: maybe(0.4, () => [
          {
            symbol: pickv(["ETHUSDT", "BTCUSDT", "BNBUSDT"]),
            emaFastPeriod: pickv([4, 8, 12]),
            emaSlowPeriod: pickv([24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: maybe(0.4, () => ({
          period: pickv([20, 30, 50, 75, 100]),
          minRatio: pickv([0.3, 0.4, 0.5, 0.6, 0.7]),
        })),
        trailingStop: {
          activatePct: pickv([0.015, 0.02, 0.025, 0.03, 0.035, 0.04]),
          trailPct: pickv([0.0005, 0.001, 0.002, 0.003, 0.005]),
        },
        momentumRanking: maybe(0.7, () => ({
          lookbackBars: pickv([4, 6, 12, 24]),
          topN: pickv([4, 5, 6, 7]),
        })),
        breakEven: maybe(0.5, () => ({
          threshold: pickv([0.015, 0.02, 0.025, 0.03]),
        })),
        fundingRateFilter: maybe(0.6, () => ({
          maxFundingForLong: pickv([
            0.0003, 0.0005, 0.0008, 0.001, 0.0015, 0.002,
          ]),
        })),
        timeBoost: maybe(0.3, () => ({
          afterDay: pickv([4, 6, 8, 12]),
          equityBelow: pickv([0.02, 0.04, 0.06]),
          factor: pickv([1.3, 1.5, 2]),
        })),
      };
      if (
        cfg.crossAssetFilter &&
        cfg.crossAssetFilter.emaSlowPeriod <= cfg.crossAssetFilter.emaFastPeriod
      )
        continue;
      if (
        cfg.trailingStop &&
        cfg.trailingStop.trailPct >= cfg.trailingStop.activatePct
      )
        continue;

      const r = evalCfg(cfg);
      if (r.score > best.score) {
        best = { name: `trial ${trial}`, cfg, ...r };
        log(
          `  *** trial ${trial} mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
        );
      }
      if ((trial + 1) % 500 === 0) {
        log(
          `  ${trial + 1}/5000 — best score=${(best.score * 100).toFixed(2)}% mean=${(best.mean * 100).toFixed(2)}%`,
        );
      }
    }

    log(`\n========== R54 RESULT ==========`);
    log(
      `THEORETICAL CEILING (no live caps): mean=${(noCapsR.mean * 100).toFixed(2)}%`,
    );
    log(
      `LIVE-USABLE CHAMPION: ${best.name} mean=${(best.mean * 100).toFixed(2)}% min=${(best.min * 100).toFixed(2)}% recent3=${(best.recent3 * 100).toFixed(2)}% TL=${(best.meanTL * 100).toFixed(2)}%`,
    );
    if (best.score > baseR.score) {
      writeFileSync(
        `${LOG_DIR}/R54_BEST.json`,
        JSON.stringify(best.cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
