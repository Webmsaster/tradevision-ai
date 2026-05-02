/**
 * R51 — combine R50 wins: drop DOGE + funding + BTC CAF
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
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
const LOG_FILE = `${LOG_DIR}/R51_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R51 — combine R50 wins", { timeout: 24 * 3600_000 }, () => {
  it("runs R51", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R51 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME);
    log(
      `V5_PRIME: mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}% TL=${(baseR.meanTL * 100).toFixed(2)}% score=${(baseR.score * 100).toFixed(2)}%`,
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

    // Build base: V5_PRIME minus DOGE
    const noDoge: FtmoDaytrade24hConfig = {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME.assets.filter(
        (a) => a.symbol !== "DOGE-TREND",
      ),
    };
    maybe("noDoge (V5_PRIME - DOGE)", noDoge);

    // noDoge + funding sweep
    log(`\n========== noDoge + funding ==========`);
    for (const maxFL of [0.0005, 0.0008, 0.001, 0.0015, 0.002]) {
      maybe(`noDoge + fund=${maxFL}`, {
        ...noDoge,
        fundingRateFilter: { maxFundingForLong: maxFL },
      });
    }

    // noDoge + BTC CAF
    log(`\n========== noDoge + BTC CAF ==========`);
    for (const fast of [4, 8, 12]) {
      for (const slow of [12, 24, 48]) {
        if (slow <= fast) continue;
        for (const ml of [-0.05, -0.03]) {
          maybe(`noDoge BTC ${fast}/${slow} ml=${ml}`, {
            ...noDoge,
            crossAssetFilter: {
              symbol: "BTCUSDT",
              emaFastPeriod: fast,
              emaSlowPeriod: slow,
              skipLongsIfSecondaryDowntrend: false,
              momentumBars: 24,
              momSkipLongBelow: ml,
            },
          });
        }
      }
    }

    // noDoge + funding + BTC CAF triple combo
    log(`\n========== noDoge + funding + BTC CAF ==========`);
    for (const maxFL of [0.0008, 0.001]) {
      for (const slow of [12, 24, 48]) {
        for (const ml of [-0.05, -0.03]) {
          maybe(`noDoge fund=${maxFL} BTC 4/${slow} ml=${ml}`, {
            ...noDoge,
            fundingRateFilter: { maxFundingForLong: maxFL },
            crossAssetFilter: {
              symbol: "BTCUSDT",
              emaFastPeriod: 4,
              emaSlowPeriod: slow,
              skipLongsIfSecondaryDowntrend: false,
              momentumBars: 24,
              momSkipLongBelow: ml,
            },
          });
        }
      }
    }

    // V5_PRIME + funding 0.0008 alone (best from R50)
    log(`\n========== V5_PRIME + funding only ==========`);
    maybe("V5_PRIME + fund=0.0008", {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
      fundingRateFilter: { maxFundingForLong: 0.0008 },
    });

    // Try drop another asset on top of drop DOGE
    log(`\n========== noDoge + drop another ==========`);
    for (const sym of noDoge.assets.map((a) => a.symbol)) {
      const cfg: FtmoDaytrade24hConfig = {
        ...noDoge,
        assets: noDoge.assets.filter((a) => a.symbol !== sym),
      };
      maybe(`noDoge + drop ${sym}`, cfg);
    }

    log(`\n========== R51 SUMMARY ==========`);
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
        `${LOG_DIR}/R51_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
