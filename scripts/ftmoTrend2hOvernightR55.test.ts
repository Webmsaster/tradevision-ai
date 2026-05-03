/**
 * R55 — exotic trend explorations: MR-longs, longer TFs, alternative entries
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
const LOG_FILE = `${LOG_DIR}/R55_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R55 — exotic trends", { timeout: 24 * 3600_000 }, () => {
  it("runs R55", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R55 START ${new Date().toISOString()}\n`);

    function makeEvalContext(tfName: string, tfHours: number) {
      const barsPerDay = 24 / tfHours;
      const sixMo = Math.floor(0.5 * 365 * barsPerDay);
      const winBars = 30 * barsPerDay;
      const stepBars = 3 * barsPerDay;
      return { tfName, tfHours, barsPerDay, sixMo, winBars, stepBars };
    }

    async function loadDataForTF(tfName: string) {
      const data: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        try {
          data[s] = await loadBinanceHistory({
            symbol: s,
            timeframe: tfName as any,
            targetCount: 30000,
            maxPages: 80,
          });
        } catch (e) {
          log(`  ${s}@${tfName}: FAIL`);
          throw e;
        }
      }
      const n = Math.min(...Object.values(data).map((c) => c.length));
      for (const s of SOURCES) data[s] = data[s].slice(-n);
      return { data, n };
    }

    function evalCfg(
      cfg: FtmoDaytrade24hConfig,
      data: Record<string, Candle[]>,
      ctx: ReturnType<typeof makeEvalContext>,
      fundingBySymbol?: Record<string, (number | null)[]>,
    ) {
      const rates: number[] = [];
      const tlRates: number[] = [];
      const numSlices = Math.floor(data[SOURCES[0]].length / ctx.sixMo);
      for (let si = 0; si < numSlices; si++) {
        let p = 0,
          w = 0,
          tl = 0;
        const sliceStart = si * ctx.sixMo;
        const sliceEnd = (si + 1) * ctx.sixMo;
        for (
          let s = sliceStart;
          s + ctx.winBars <= sliceEnd;
          s += ctx.stepBars
        ) {
          const sub: Record<string, Candle[]> = {};
          const subFund: Record<string, (number | null)[]> = {};
          for (const sym of SOURCES) {
            sub[sym] = data[sym].slice(s, s + ctx.winBars);
            if (fundingBySymbol && fundingBySymbol[sym])
              subFund[sym] = fundingBySymbol[sym].slice(s, s + ctx.winBars);
          }
          const r = runFtmoDaytrade24h(
            sub,
            cfg,
            fundingBySymbol ? subFund : undefined,
          );
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

    // Phase 1: MR-longs on 2h (buy after N reds, opposite of trend)
    log(`\n========== Phase 1: 2h Mean-Reversion LONGS ==========`);
    {
      const ctx = makeEvalContext("2h", 2);
      const { data } = await loadDataForTF("2h");
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs =
        data[SOURCES[0]][data[SOURCES[0]].length - 1].openTime + 2 * 3600_000;
      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        fundingBySymbol[s] = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
      }

      // MR-long config: invertDirection=false (= MR mode), trigger N reds → LONG
      function makeMRAsset(s: string, tb: number): Daytrade24hAssetCfg {
        return {
          symbol: `${s.replace("USDT", "")}-MR`,
          sourceSymbol: s,
          costBp: 30,
          slippageBp: 8,
          swapBpPerDay: 4,
          riskFrac: 1.0,
          triggerBars: tb,
          invertDirection: false, // MR mode
          disableShort: true,
          disableLong: false,
          stopPct: 0.03, // tighter stop for MR
          tpPct: 0.025, // smaller TP for MR (asymmetric)
          holdBars: 24, // 2 days
        };
      }

      for (const tb of [2, 3, 4]) {
        for (const tp of [0.02, 0.025, 0.03]) {
          const mrCfg: FtmoDaytrade24hConfig = {
            triggerBars: tb,
            leverage: 2,
            tpPct: tp,
            stopPct: 0.03,
            holdBars: 24,
            timeframe: "2h",
            maxConcurrentTrades: 6,
            assets: SOURCES.map((s) => ({ ...makeMRAsset(s, tb), tpPct: tp })),
            profitTarget: 0.1,
            maxDailyLoss: 0.05,
            maxTotalLoss: 0.1,
            minTradingDays: 4,
            maxDays: 30,
            pauseAtTargetReached: true,
            liveCaps: { maxStopPct: 0.05, maxRiskFrac: 0.4 },
          };
          const r = evalCfg(mrCfg, data, ctx, fundingBySymbol);
          log(
            `  MR-long tb=${tb} tp=${tp}: mean=${(r.mean * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
          );
        }
      }
    }

    // Phase 2: 8h timeframe with V5_PRIMEX-style
    log(`\n========== Phase 2: 8h timeframe (slower trends) ==========`);
    try {
      const ctx = makeEvalContext("8h", 8);
      const { data } = await loadDataForTF("8h");
      log(
        `  8h aligned: ${data[SOURCES[0]].length} bars (${(data[SOURCES[0]].length / ctx.barsPerDay / 365).toFixed(2)}y)`,
      );
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs =
        data[SOURCES[0]][data[SOURCES[0]].length - 1].openTime + 8 * 3600_000;
      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        fundingBySymbol[s] = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
      }
      const cfg8h: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        timeframe: "4h" as any, // engine uses actual candle delta anyway
        holdBars: 60, // 8h × 60 = 20 days
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) => ({
          ...a,
          holdBars: 60,
        })),
      };
      const r = evalCfg(cfg8h, data, ctx, fundingBySymbol);
      log(
        `  PRIMEX-style 8h: mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
      );
    } catch (e) {
      log(`  8h FAIL: ${(e as Error).message}`);
    }

    // Phase 3: 1d (daily) timeframe
    log(`\n========== Phase 3: 1d timeframe ==========`);
    try {
      const ctx = makeEvalContext("1d", 24);
      const { data } = await loadDataForTF("1d");
      log(
        `  1d aligned: ${data[SOURCES[0]].length} bars (${(data[SOURCES[0]].length / 365).toFixed(2)}y)`,
      );
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs =
        data[SOURCES[0]][data[SOURCES[0]].length - 1].openTime + 24 * 3600_000;
      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        fundingBySymbol[s] = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
      }
      const cfg1d: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
        timeframe: "4h" as any,
        holdBars: 20, // 20 days max
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map((a) => ({
          ...a,
          holdBars: 20,
        })),
      };
      const r = evalCfg(cfg1d, data, ctx, fundingBySymbol);
      log(
        `  PRIMEX-style 1d: mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
      );
    } catch (e) {
      log(`  1d FAIL: ${(e as Error).message}`);
    }

    // Phase 4: bbKc Squeeze + NR7 alternative entries on 2h
    log(`\n========== Phase 4: alternative entries on 2h ==========`);
    {
      const ctx = makeEvalContext("2h", 2);
      const { data } = await loadDataForTF("2h");
      const startMs = data[SOURCES[0]][0].openTime;
      const endMs =
        data[SOURCES[0]][data[SOURCES[0]].length - 1].openTime + 2 * 3600_000;
      const fundingBySymbol: Record<string, (number | null)[]> = {};
      for (const s of SOURCES) {
        const rows = await loadBinanceFundingRate(s, startMs, endMs);
        fundingBySymbol[s] = alignFundingToCandles(
          rows,
          data[s].map((c) => c.openTime),
        );
      }

      // bbKc squeeze entry
      for (const minSqueeze of [3, 6, 12]) {
        const cfgBBKC: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map(
            (a) => ({
              ...a,
              bbKcSqueezeEntry: {
                bbPeriod: 20,
                bbSigma: 2,
                kcPeriod: 20,
                kcMult: 1.5,
                minSqueezeBars: minSqueeze,
              },
            }),
          ),
        };
        const r = evalCfg(cfgBBKC, data, ctx, fundingBySymbol);
        log(
          `  bbKc squeeze=${minSqueeze}: mean=${(r.mean * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
        );
      }

      // nr7 (volatility breakout)
      for (const cb of [3, 5, 7, 10]) {
        const cfgNR7: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_PRIMEX.assets.map(
            (a) => ({
              ...a,
              nr7Entry: { compressionBars: cb },
            }),
          ),
        };
        const r = evalCfg(cfgNR7, data, ctx, fundingBySymbol);
        log(
          `  nr7 cb=${cb}: mean=${(r.mean * 100).toFixed(2)}% TL=${(r.meanTL * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
        );
      }
    }

    expect(true).toBe(true);
  });
});
