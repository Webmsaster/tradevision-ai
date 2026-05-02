/**
 * R47 — random search 3000 trials anchored on V5_NOVA
 * Verify NOVA reproduces, find next champion.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
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
const LOG_FILE = `${LOG_DIR}/R47_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
  "DOGEUSDT",
  "AVAXUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "LINKUSDT",
];

describe("R47 — random search on NOVA", { timeout: 24 * 3600_000 }, () => {
  it("runs R47", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R47 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA);
    log(
      `V5_NOVA: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );

    let best = {
      name: "NOVA",
      cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
      ...baseR,
    };

    log(`\nRunning 3000 trials anchored on NOVA...`);
    for (let trial = 0; trial < 3000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 12);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA,
        allowedHoursUtc: hours,
        adxFilter: {
          period: pickv([10, 14, 20, 28]),
          minAdx: pickv([0, 5, 10, 12, 15]),
        },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pickv([12, 24, 48, 72, 120]),
          apply: pickv(["long", "both"] as const),
          threshold: pickv([-0.05, 0, 0.02, 0.05]),
        })),
        chandelierExit: maybe(0.7, () => ({
          period: pickv([28, 56, 84, 168]),
          mult: pickv([1.5, 2, 2.5, 3]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.4, () => ({
          period: pickv([10, 14, 20]),
          maxCi: pickv([60, 65, 70, 72, 75, 78]),
        })),
        lossStreakCooldown: maybe(0.4, () => ({
          afterLosses: pickv([2, 3, 4]),
          cooldownBars: pickv([24, 48, 72, 120]),
        })),
        crossAssetFilter: {
          symbol: pickv(["BTCUSDT", "ETHUSDT"]),
          emaFastPeriod: pickv([4, 6, 8, 12]),
          emaSlowPeriod: pickv([12, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pickv([12, 18, 24, 36, 48]),
          momSkipLongBelow: pickv([-0.05, -0.03, -0.02, -0.01, 0]),
        },
        crossAssetFiltersExtra: maybe(0.4, () => [
          {
            symbol: pickv(["ETHUSDT", "BTCUSDT", "BNBUSDT"]),
            emaFastPeriod: pickv([4, 8]),
            emaSlowPeriod: pickv([24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: maybe(0.4, () => ({
          period: pickv([20, 30, 50, 75, 100]),
          minRatio: pickv([0.3, 0.4, 0.5, 0.6, 0.7]),
        })),
        trailingStop: {
          activatePct: pickv([0.02, 0.025, 0.03, 0.04]),
          trailPct: pickv([0.001, 0.002, 0.003, 0.005]),
        },
        momentumRanking: maybe(0.7, () => ({
          lookbackBars: pickv([6, 12, 24]),
          topN: pickv([5, 6, 7, 8]),
        })),
        breakEven: maybe(0.5, () => ({
          threshold: pickv([0.02, 0.025, 0.03]),
        })),
        fundingRateFilter: { maxFundingForLong: pickv([0.0005, 0.001, 0.002]) },
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_NOVA.assets.map((a) => ({
          ...a,
          tpPct: pickv([0.06, 0.07, 0.08]),
          holdBars: pickv([180, 240, 360]),
          volTargeting: a.volTargeting
            ? {
                period: 24,
                minMult: 0.5,
                targetAtrFrac: pickv([0.025, 0.03, 0.035, 0.04]),
                maxMult: pickv([1.0, 1.2, 1.5]),
              }
            : a.volTargeting,
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
          `  *** trial ${trial} BEST score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
        );
      }
      if ((trial + 1) % 500 === 0) {
        log(
          `  ${trial + 1}/3000 — best score=${(best.score * 100).toFixed(2)}%`,
        );
      }
    }

    log(`\n========== R47 RESULT ==========`);
    log(
      `Best: ${best.name} score=${(best.score * 100).toFixed(2)}% mean=${(best.mean * 100).toFixed(2)}% min=${(best.min * 100).toFixed(2)}% recent3=${(best.recent3 * 100).toFixed(2)}%`,
    );
    if (best.score > baseR.score) {
      writeFileSync(
        `${LOG_DIR}/R47_BEST.json`,
        JSON.stringify(best.cfg, null, 2),
      );
      log(`Δ: +${((best.score - baseR.score) * 100).toFixed(2)}pp`);
    }

    expect(true).toBe(true);
  });
});
