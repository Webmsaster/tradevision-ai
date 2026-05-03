/**
 * R52 — Multi-TF: V5_PRIMEX-style auf 30m, 1h, 4h getunt + Pareto-vergleich
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

const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R52_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R52 — Multi-TF V5_PRIMEX style", { timeout: 24 * 3600_000 }, () => {
  it("runs R52", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R52 START ${new Date().toISOString()}\n`);

    log(`========== Test V5_PRIMEX adapted to TF=30m, 1h, 2h, 4h ==========`);

    const tfs = [
      { name: "30m", hours: 0.5, barsPerDay: 48, scale: 4 },
      { name: "1h", hours: 1, barsPerDay: 24, scale: 2 },
      { name: "2h", hours: 2, barsPerDay: 12, scale: 1 },
      { name: "4h", hours: 4, barsPerDay: 6, scale: 0.5 },
    ] as const;

    for (const tf of tfs) {
      log(`\n----- TF=${tf.name} -----`);
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: tf.name,
            targetCount: 100000,
            maxPages: 200,
          });
          log(
            `  ${s}: ${data[s].length} bars (${(data[s].length / tf.barsPerDay / 365).toFixed(2)}y)`,
          );
        } catch (e) {
          log(`  ${s}: FAIL ${(e as Error).message}`);
          return;
        }
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs = data[SOURCES[0]][n - 1].openTime + tf.hours * 3600_000;
      log(`  Aligned: ${n} bars (${(n / tf.barsPerDay / 365).toFixed(2)}y)`);

      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        try {
          const rows = await loadBinanceFundingRate(s, startMs, endMs);
          fundingBySymbol[s] = alignFundingToCandles(
            rows,
            data[s].map((c) => c.openTime),
          );
        } catch {
          fundingBySymbol[s] = new Array(data[s].length).fill(null);
        }
      }

      const sixMo = Math.floor(0.5 * 365 * tf.barsPerDay);
      const numSlices = Math.floor(n / sixMo);

      function evalCfg(cfg: FtmoDaytrade24hConfig) {
        const rates: number[] = [];
        const tlRates: number[] = [];
        const passDaysAll: number[] = [];
        const winBars = 30 * tf.barsPerDay;
        const stepBars = 3 * tf.barsPerDay;
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
            if (r.passed) {
              p++;
              if (r.trades.length > 0)
                passDaysAll.push(r.trades[r.trades.length - 1].day + 1);
            }
            if (r.reason === "total_loss") tl++;
            w++;
          }
          rates.push(w > 0 ? p / w : 0);
          tlRates.push(w > 0 ? tl / w : 0);
        }
        passDaysAll.sort((a, b) => a - b);
        const median = passDaysAll[Math.floor(passDaysAll.length * 0.5)] ?? 0;
        const p90 = passDaysAll[Math.floor(passDaysAll.length * 0.9)] ?? 0;
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const min = Math.min(...rates);
        const std = Math.sqrt(
          rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length,
        );
        const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / 3;
        const meanTL = tlRates.reduce((a, b) => a + b, 0) / tlRates.length;
        const score = mean - 0.5 * std - 2.0 * meanTL;
        const realMed = Math.max(median, cfg.minTradingDays ?? 4);
        const realP90 = Math.max(p90, cfg.minTradingDays ?? 4);
        return {
          mean,
          min,
          std,
          recent3,
          meanTL,
          score,
          median,
          p90,
          realMed,
          realP90,
        };
      }

      // Adapt PRIMEX config: holdBars scale by TF (240 was for 2h = 20d).
      const holdBarsTf = Math.round(240 * tf.scale);
      const tfCfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        timeframe: tf.name as any,
        holdBars: holdBarsTf,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) => ({
          ...a,
          holdBars: holdBarsTf,
        })),
      };

      const r = evalCfg(tfCfg);
      log(
        `  PRIMEX-${tf.name}: mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% engineMed=${r.median}d realMed=${r.realMed}d engineP90=${r.p90}d score=${(r.score * 100).toFixed(2)}%`,
      );

      // Try a few variants per TF
      const variants: Array<[string, Partial<FtmoDaytrade24hConfig>]> = [
        ["minRank top=5", { momentumRanking: { lookbackBars: 6, topN: 5 } }],
        ["minRank top=7", { momentumRanking: { lookbackBars: 6, topN: 7 } }],
        [
          "chand p=56",
          { chandelierExit: { period: 56, mult: 2.5, minMoveR: 0.5 } },
        ],
        ["adx 14/15", { adxFilter: { period: 14, minAdx: 15 } }],
        ["fund=0.001", { fundingRateFilter: { maxFundingForLong: 0.001 } }],
      ];
      for (const [vname, vcfg] of variants) {
        const r2 = evalCfg({ ...tfCfg, ...vcfg });
        const tag = r2.score > r.score ? "🚀" : "·";
        log(
          `  ${tag} +${vname}: mean=${(r2.mean * 100).toFixed(2)}% min=${(r2.min * 100).toFixed(2)}% recent3=${(r2.recent3 * 100).toFixed(2)}% TL=${(r2.meanTL * 100).toFixed(2)}% realMed=${r2.realMed}d score=${(r2.score * 100).toFixed(2)}%`,
        );
      }
    }

    expect(true).toBe(true);
  });
});
