/**
 * R50 — V5_PRIME + funding filter / + new assets / + multi-TF / + pullback ideas
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
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
const LOG_FILE = `${LOG_DIR}/R50_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const SOURCES_BASE = [
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

describe("R50 — V5_PRIME extensions", { timeout: 24 * 3600_000 }, () => {
  it("runs R50", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R50 START ${new Date().toISOString()}\n`);

    const data: Record<string, Candle[]> = {};
    for (const s of SOURCES_BASE) {
      data[s] = await loadBinanceHistory({
        symbol: s,
        timeframe: "2h",
        targetCount: 30000,
        maxPages: 40,
      });
    }
    const n = Math.min(...Object.values(data).map((c) => c.length));
    for (const s of SOURCES_BASE) data[s] = data[s].slice(-n);
    const startMs = data[SOURCES_BASE[0]][0].openTime;
    const endMs = data[SOURCES_BASE[0]][n - 1].openTime + 2 * 3600_000;

    const fundingBySymbol: Record<string, (number | null)[]> = {};
    for (const s of SOURCES_BASE) {
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
          for (const sym of SOURCES_BASE) {
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

    // 50A: V5_PRIME + funding filter sweep
    log(`\n========== 50A: V5_PRIME + funding ==========`);
    for (const maxFL of [0.0003, 0.0005, 0.0008, 0.001, 0.0015, 0.002]) {
      maybe(`+funding maxFL=${maxFL}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
        fundingRateFilter: { maxFundingForLong: maxFL },
      });
    }

    // 50B: V5_PRIME + volumeFilter (R31 winner used p=50/r=0.5)
    log(`\n========== 50B: V5_PRIME + volumeFilter ==========`);
    for (const period of [30, 50, 75, 100]) {
      for (const ratio of [0.4, 0.5, 0.6]) {
        maybe(`+vol p=${period} r=${ratio}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
          volumeFilter: { period, minRatio: ratio },
        });
      }
    }

    // 50C: V5_PRIME + crossAssetFilter (BTC)
    log(`\n========== 50C: V5_PRIME + BTC CAF ==========`);
    for (const fast of [4, 8, 12]) {
      for (const slow of [12, 24, 48]) {
        if (slow <= fast) continue;
        for (const mb of [12, 24, 48]) {
          for (const ml of [-0.05, -0.02, 0]) {
            maybe(`BTC ${fast}/${slow} mb=${mb} ml=${ml}`, {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
              crossAssetFilter: {
                symbol: "BTCUSDT",
                emaFastPeriod: fast,
                emaSlowPeriod: slow,
                skipLongsIfSecondaryDowntrend: false,
                momentumBars: mb,
                momSkipLongBelow: ml,
              },
            });
          }
        }
      }
    }

    // 50D: V5_PRIME + breakEven
    log(`\n========== 50D: V5_PRIME + breakEven ==========`);
    for (const thr of [0.015, 0.02, 0.025, 0.03]) {
      maybe(`+breakEven=${thr}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
        breakEven: { threshold: thr },
      });
    }

    // 50E: V5_PRIME + LSC (R8 found a=3 cd=48)
    log(`\n========== 50E: V5_PRIME + LSC ==========`);
    for (const after of [2, 3, 4]) {
      for (const cd of [24, 48, 72, 120]) {
        maybe(`+LSC a=${after} cd=${cd}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        });
      }
    }

    // 50F: V5_PRIME drop one asset (greedy)
    log(`\n========== 50F: drop one asset ==========`);
    for (const sym of FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME.assets.map(
      (a) => a.symbol,
    )) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIME.assets.filter(
          (a) => a.symbol !== sym,
        ),
      };
      maybe(`drop ${sym}`, cfg);
    }

    log(`\n========== R50 SUMMARY ==========`);
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
        `${LOG_DIR}/R50_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
