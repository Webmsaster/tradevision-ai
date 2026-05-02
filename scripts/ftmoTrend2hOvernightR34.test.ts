/**
 * R34 — momentumRanking + per-asset funding sweep
 *
 * 34A: V5_ULTRA + momentumRanking sweep (lookback × topN)
 *      Idea: only trade top-N momentum assets each bar (skip laggards)
 * 34B: per-asset fundingRateFilter (DOGE has different baseline than BTC)
 *      Need new engine support: per-asset overrides
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
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
const LOG_FILE = `${LOG_DIR}/R34_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  "R34 — momentum ranking + per-asset funding",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R34", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R34 START ${new Date().toISOString()}\n`);

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

      log(`Loading funding...`);
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

      function evalCfg(cfg: FtmoDaytrade24hConfig, useFunding: boolean) {
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
              if (useFunding)
                subFund[sym] = fundingBySymbol[sym].slice(s, s + winBars);
            }
            const r = runFtmoDaytrade24h(
              sub,
              cfg,
              useFunding ? subFund : undefined,
            );
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
        return { rates, mean, min, std, recent3 };
      }

      log(`========== Baseline ==========`);
      const ultraR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA, true);
      log(
        `V5_ULTRA: mean=${(ultraR.mean * 100).toFixed(2)}% min=${(ultraR.min * 100).toFixed(2)}% std=${(ultraR.std * 100).toFixed(2)}% recent3=${(ultraR.recent3 * 100).toFixed(2)}%`,
      );

      // 34A: momentumRanking sweep on V5_ULTRA
      log(`\n========== 34A: V5_ULTRA + momentumRanking ==========`);
      log(`${"lb × topN".padEnd(15)} mean    min     std    recent3 score`);
      let bestRank = {
        name: "ultra-base",
        mean: ultraR.mean,
        min: ultraR.min,
        std: ultraR.std,
        recent3: ultraR.recent3,
      };
      for (const lb of [12, 24, 48, 72, 120, 240]) {
        for (const topN of [3, 4, 5, 6, 7]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
            momentumRanking: { lookbackBars: lb, topN },
          };
          const r = evalCfg(cfg, true);
          const score = r.mean - 0.5 * r.std;
          const ultraScore = ultraR.mean - 0.5 * ultraR.std;
          const tag = score > ultraScore ? "✓" : "·";
          log(
            `  lb=${String(lb).padStart(3)} top=${topN}     ${(r.mean * 100).toFixed(2)}%  ${(r.min * 100).toFixed(2)}%  ${(r.std * 100).toFixed(2)}%  ${(r.recent3 * 100).toFixed(2)}%  ${(score * 100).toFixed(2)}% ${tag}`,
          );
          if (score > bestRank.mean - 0.5 * bestRank.std) {
            bestRank = {
              name: `lb=${lb} top=${topN}`,
              mean: r.mean,
              min: r.min,
              std: r.std,
              recent3: r.recent3,
            };
          }
        }
      }
      log(
        `BEST 34A: ${bestRank.name} score=${((bestRank.mean - 0.5 * bestRank.std) * 100).toFixed(2)}%`,
      );

      // 34B: per-asset funding (set per-asset BUT engine doesn't support — global only)
      // Workaround: set very loose maxFunding so it only blocks extreme outliers per-asset
      // Try: scale threshold by per-asset funding p90
      log(`\n========== 34B: per-asset adaptive funding ==========`);
      log(`Per-asset funding p75 / p90 / p95:`);
      for (const s of SOURCES) {
        const valid = (fundingBySymbol[s] ?? []).filter(
          (x) => x !== null,
        ) as number[];
        valid.sort((a, b) => a - b);
        const pick = (q: number) => valid[Math.floor(valid.length * q)];
        log(
          `  ${s.padEnd(10)} p75=${(pick(0.75) * 100).toFixed(4)}% p90=${(pick(0.9) * 100).toFixed(4)}% p95=${(pick(0.95) * 100).toFixed(4)}% p99=${(pick(0.99) * 100).toFixed(4)}%`,
        );
      }

      // Test different maxFL thresholds (the global filter applies same to all)
      log(`\nGlobal maxFundingForLong sweep on V5_ULTRA (deeper):`);
      for (const maxFL of [
        0.0001, 0.0002, 0.0003, 0.0005, 0.0008, 0.001, 0.0015, 0.002, 0.003,
      ]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
          fundingRateFilter: { maxFundingForLong: maxFL },
        };
        const r = evalCfg(cfg, true);
        log(
          `  maxFL=${maxFL.toFixed(4)} mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
        );
      }

      // 34C: Combine momentumRanking with V5_ULTRA's best
      log(`\n========== 34C: V5_ULTRA + best momRanking variants ==========`);
      const variants = [
        { name: "no-rank base", mr: undefined },
        { name: "lb=24 top=5", mr: { lookbackBars: 24, topN: 5 } },
        { name: "lb=48 top=5", mr: { lookbackBars: 48, topN: 5 } },
        { name: "lb=48 top=4", mr: { lookbackBars: 48, topN: 4 } },
        { name: "lb=72 top=5", mr: { lookbackBars: 72, topN: 5 } },
      ];
      for (const v of variants) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
          momentumRanking: v.mr,
        };
        const r = evalCfg(cfg, true);
        log(
          `  ${v.name.padEnd(20)} mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% std=${(r.std * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}%`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
