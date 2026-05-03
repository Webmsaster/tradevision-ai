/**
 * R45 — strategy-switching by challenge day + creative axes
 *
 * 45A: phase-split (e.g. days 0-10 aggressive, days 11+ conservative)
 * 45B: re-entry after stop (signal still valid)
 * 45C: per-asset minTradingDays (some early-only)
 * 45D: BTC-only or BTC+ETH only (concentration)
 * 45E: assets with breakEven 1% to lock early profits
 * 45F: combine V5_TITAN_REAL + maCrossEntry on subset
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
const LOG_FILE = `${LOG_DIR}/R45_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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
  "R45 — strategy-switching + creative",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R45", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R45 START ${new Date().toISOString()}\n`);

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

      // 45A: phase-split — first half tighter, second half loose (rescue)
      log(`\n========== 45A: phase-split via activateAfterDay ==========`);
      function withPhaseSplit(
        splitDay: number,
        lateRiskMult: number,
      ): FtmoDaytrade24hConfig {
        const earlyAssets =
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map((a) => ({
            ...a,
            deactivateAfterDay: splitDay,
          }));
        const lateAssets =
          FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map((a) => ({
            ...a,
            symbol: a.symbol + "-LATE",
            sourceSymbol: a.sourceSymbol ?? a.symbol,
            activateAfterDay: splitDay,
            riskFrac: a.riskFrac * lateRiskMult,
          }));
        return {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          assets: [...earlyAssets, ...lateAssets],
        };
      }
      for (const split of [10, 15, 20]) {
        for (const mult of [0.8, 1.0, 1.2, 1.5]) {
          maybe(
            `split d=${split} lateMult=${mult}`,
            withPhaseSplit(split, mult),
          );
        }
      }

      // 45B: BTC-only / BTC+ETH-only concentration
      log(`\n========== 45B: concentration ==========`);
      for (const keep of [
        ["BTC-TREND"],
        ["BTC-TREND", "ETH-TREND"],
        ["BTC-TREND", "ETH-TREND", "BNB-TREND"],
        ["BTC-TREND", "ETH-TREND", "BNB-TREND", "LINK-TREND"],
      ]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.filter(
            (a) => keep.includes(a.symbol),
          ),
        };
        maybe(`only ${keep.length} assets: ${keep.join(",")}`, cfg);
      }

      // 45C: breakEven sweep
      log(`\n========== 45C: breakEven ==========`);
      for (const thr of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
        maybe(`breakEven thr=${thr}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          breakEven: { threshold: thr },
        });
      }

      // 45D: maCrossEntry — replace default trigger with EMA crossover
      log(`\n========== 45D: maCrossEntry ==========`);
      for (const fast of [4, 8, 12]) {
        for (const slow of [12, 20, 30]) {
          if (slow <= fast) continue;
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map(
              (a) => ({
                ...a,
                maCrossEntry: { fastPeriod: fast, slowPeriod: slow },
              }),
            ),
          };
          maybe(`maCross ${fast}/${slow}`, cfg);
        }
      }

      // 45E: tsMomentumEntry
      log(`\n========== 45E: tsMomentumEntry ==========`);
      for (const lb of [12, 24, 48]) {
        for (const thr of [0.01, 0.02, 0.03, 0.05]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
            assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map(
              (a) => ({
                ...a,
                tsMomentumEntry: { lookbackBars: lb, threshold: thr },
              }),
            ),
          };
          maybe(`tsMom lb=${lb} thr=${thr}`, cfg);
        }
      }

      // 45F: heterogeneous tp per asset (asymmetric R:R)
      log(`\n========== 45F: per-asset asymmetric tp ==========`);
      const tpVariants = [
        {
          name: "BTC=0.05 ETH=0.06 alts=0.07",
          map: { "BTC-TREND": 0.05, "ETH-TREND": 0.06 } as Record<
            string,
            number
          >,
        },
        {
          name: "BTC=0.06 ETH=0.07 alts=0.08",
          map: { "BTC-TREND": 0.06, "ETH-TREND": 0.07 } as Record<
            string,
            number
          >,
        },
        {
          name: "BTC=0.06 alts=0.08",
          map: { "BTC-TREND": 0.06 } as Record<string, number>,
        },
        {
          name: "DOGE=0.10 alts=0.07",
          map: { "DOGE-TREND": 0.1 } as Record<string, number>,
        },
      ];
      for (const v of tpVariants) {
        const defaultTp = v.name.includes("alts=0.08") ? 0.08 : 0.07;
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN_REAL.assets.map(
            (a) => ({
              ...a,
              tpPct: v.map[a.symbol] ?? defaultTp,
            }),
          ),
        };
        maybe(v.name, cfg);
      }

      log(`\n========== R45 SUMMARY ==========`);
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
          `${LOG_DIR}/R45_BEST.json`,
          JSON.stringify(wins[0].cfg, null, 2),
        );
      }

      expect(true).toBe(true);
    });
  },
);
