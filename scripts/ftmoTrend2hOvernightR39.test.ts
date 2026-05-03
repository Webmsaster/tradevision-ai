/**
 * R39 — push TITAN further: greedy drop more, asset re-tune, ensemble idea
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
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
const LOG_FILE = `${LOG_DIR}/R39_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R39 — push TITAN", { timeout: 24 * 3600_000 }, () => {
  it("runs R39", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R39 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN);
    log(
      `V5_TITAN: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
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

    // 39A: greedy drop continue (drop AVAX + try more)
    log(`\n========== 39A: greedy drop on TITAN ==========`);
    let cur = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN;
    let curR = baseR;
    let stillImp = true;
    let dropped = ["AVAX-TREND"];
    while (stillImp && cur.assets.length > 4) {
      stillImp = false;
      let stepBest: {
        cfg: FtmoDaytrade24hConfig;
        r: typeof baseR;
        sym: string;
      } | null = null;
      for (const a of cur.assets) {
        const trial: FtmoDaytrade24hConfig = {
          ...cur,
          assets: cur.assets.filter((x) => x.symbol !== a.symbol),
        };
        const r = evalCfg(trial);
        if (r.score > curR.score) {
          if (stepBest === null || r.score > stepBest.r.score)
            stepBest = { cfg: trial, r, sym: a.symbol };
        }
      }
      if (stepBest) {
        cur = stepBest.cfg;
        curR = stepBest.r;
        dropped.push(stepBest.sym);
        stillImp = true;
        log(
          `  🚀 drop ${stepBest.sym} → score=${(curR.score * 100).toFixed(2)}% mean=${(curR.mean * 100).toFixed(2)}%`,
        );
        wins.push({ name: `drop ${dropped.join("+")}`, cfg: cur, ...curR });
      } else {
        log(`  · no further drop helps. final: ${dropped.join("+")}`);
      }
    }

    // 39B: re-tune volTgt on TITAN
    log(`\n========== 39B: volTgt re-tune on TITAN ==========`);
    for (const tgt of [0.025, 0.03, 0.035, 0.04, 0.045, 0.05]) {
      for (const mult of [3, 4, 5, 6, 8, 10]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN.assets.map(
            (a) => ({
              ...a,
              volTargeting: {
                period: 24,
                targetAtrFrac: tgt,
                minMult: 0.5,
                maxMult: mult,
              },
            }),
          ),
        };
        maybe(`volTgt ${tgt}/${mult}`, cfg);
      }
    }

    // 39C: re-tune ADX with TITAN
    log(`\n========== 39C: ADX re-tune on TITAN ==========`);
    for (const period of [8, 10, 14, 20]) {
      for (const minAdx of [10, 12, 15, 18, 20, 25]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
          adxFilter: { period, minAdx },
        };
        maybe(`ADX p=${period} m=${minAdx}`, cfg);
      }
    }

    // 39D: per-asset volTgt heterogeneous
    log(`\n========== 39D: per-asset heterogeneous volTgt ==========`);
    // BTC tighter (3% target), ETH wider (4%), alts tighter (3%)
    const variants = [
      {
        name: "BTC-tight ETH-wide",
        map: { "BTC-TREND": 0.025, "ETH-TREND": 0.04 } as Record<
          string,
          number
        >,
      },
      {
        name: "BTC-tight rest-3.5",
        map: { "BTC-TREND": 0.025 } as Record<string, number>,
      },
      {
        name: "ETH-tight rest-3.5",
        map: { "ETH-TREND": 0.025 } as Record<string, number>,
      },
      {
        name: "alts-wide",
        map: { "DOGE-TREND": 0.04, "ADA-TREND": 0.04 } as Record<
          string,
          number
        >,
      },
    ];
    for (const v of variants) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN.assets.map((a) => ({
          ...a,
          volTargeting: {
            period: 24,
            targetAtrFrac: v.map[a.symbol] ?? 0.035,
            minMult: 0.5,
            maxMult: 5,
          },
        })),
      };
      maybe(v.name, cfg);
    }

    // 39E: momentumRanking re-tune
    log(`\n========== 39E: momRanking re-tune (TITAN has 8 assets) ==========`);
    for (const lb of [6, 12, 24, 48]) {
      for (const topN of [4, 5, 6, 7, 8]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_TITAN,
          momentumRanking: { lookbackBars: lb, topN },
        };
        maybe(`momRank lb=${lb} top=${topN}`, cfg);
      }
    }

    log(`\n========== R39 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`\nTop 10:`);
      for (const w of wins.slice(0, 10)) {
        log(
          `  ${w.name.padEnd(45)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R39_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
