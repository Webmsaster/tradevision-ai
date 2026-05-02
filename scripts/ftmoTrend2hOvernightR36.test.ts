/**
 * R36 — combine R35 winners + fine-tune volTargeting
 *
 * Top R35 winners:
 *   - volTargeting all=0.03 maxMult=3 (+0.94pp score)
 *   - +CAF ADA 4/48 (+0.46pp score)
 *   - news blackout 240min (+0.19pp score, +2pp min)
 *
 * Test: stack all three, plus fine-tune volTgt at edges (0.035, 0.04, maxMult=4,5)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import {
  loadBinanceFundingRate,
  alignFundingToCandles,
} from "./_loadFundingRate";
import { getMacroEvents } from "./_macroEvents";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R36_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe(
  "R36 — combine winners + volTgt fine-grain",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R36", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R36 START ${new Date().toISOString()}\n`);

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

      const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE);
      log(
        `V5_ELITE base: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
      );

      const events = getMacroEvents();

      function withVolTgt(
        target: number,
        maxMult: number,
      ): Partial<FtmoDaytrade24hConfig> {
        return {
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.assets.map(
            (a) => ({
              ...a,
              volTargeting: {
                period: 24,
                targetAtrFrac: target,
                minMult: 0.5,
                maxMult,
              },
            }),
          ),
        };
      }

      function withADA(): Partial<FtmoDaytrade24hConfig> {
        return {
          crossAssetFiltersExtra: [
            ...(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.crossAssetFiltersExtra ??
              []),
            {
              symbol: "ADAUSDT",
              emaFastPeriod: 4,
              emaSlowPeriod: 48,
              skipLongsIfSecondaryDowntrend: true,
            },
          ],
        };
      }

      function withNews(buf: number): Partial<FtmoDaytrade24hConfig> {
        return { newsFilter: { events, bufferMinutes: buf } };
      }

      const candidates: { name: string; cfg: FtmoDaytrade24hConfig }[] = [];

      // Fine-grain volTgt sweep
      log(`\n========== Fine-grain volTargeting ==========`);
      for (const tgt of [0.025, 0.03, 0.035, 0.04]) {
        for (const mult of [2, 3, 4, 5, 8]) {
          candidates.push({
            name: `volTgt ${tgt}/${mult}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
              ...withVolTgt(tgt, mult),
            },
          });
        }
      }

      // ADA + various volTgt
      for (const tgt of [0.025, 0.03, 0.035]) {
        for (const mult of [2, 3, 5]) {
          candidates.push({
            name: `volTgt ${tgt}/${mult} +ADA`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
              ...withVolTgt(tgt, mult),
              ...withADA(),
            },
          });
        }
      }

      // News + volTgt
      for (const tgt of [0.025, 0.03]) {
        for (const buf of [120, 240, 360]) {
          candidates.push({
            name: `volTgt ${tgt}/3 +news${buf}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
              ...withVolTgt(tgt, 3),
              ...withNews(buf),
            },
          });
        }
      }

      // Triple combo: volTgt + ADA + news
      for (const tgt of [0.025, 0.03, 0.035]) {
        for (const mult of [2, 3, 5]) {
          for (const buf of [120, 240]) {
            candidates.push({
              name: `volTgt ${tgt}/${mult} +ADA +news${buf}`,
              cfg: {
                ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
                ...withVolTgt(tgt, mult),
                ...withADA(),
                ...withNews(buf),
              },
            });
          }
        }
      }

      type Res = {
        name: string;
        cfg: FtmoDaytrade24hConfig;
        score: number;
        mean: number;
        min: number;
        recent3: number;
      };
      const all: Res[] = [];
      for (const c of candidates) {
        const r = evalCfg(c.cfg);
        all.push({
          name: c.name,
          cfg: c.cfg,
          score: r.score,
          mean: r.mean,
          min: r.min,
          recent3: r.recent3,
        });
        const tag = r.score > baseR.score ? "🚀" : "·";
        log(
          `  ${tag} ${c.name.padEnd(45)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
        );
      }

      log(`\n========== R36 SUMMARY ==========`);
      log(`Baseline V5_ELITE: score=${(baseR.score * 100).toFixed(2)}%`);
      all.sort((a, b) => b.score - a.score);
      log(`\nTop 15 by score:`);
      for (const r of all.slice(0, 15)) {
        log(
          `  ${r.name.padEnd(45)} score=${(r.score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
        );
      }

      if (all[0].score > baseR.score) {
        writeFileSync(
          `${LOG_DIR}/R36_BEST_CONFIG.json`,
          JSON.stringify(all[0].cfg, null, 2),
        );
      }

      expect(true).toBe(true);
    });
  },
);
