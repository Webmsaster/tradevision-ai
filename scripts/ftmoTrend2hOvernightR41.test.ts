/**
 * R41 — push V5_LEGEND further: wider volTgt, ADX maxAdx, LSC retune, asset drops, deep search
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
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
const LOG_FILE = `${LOG_DIR}/R41_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
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

describe("R41 — push V5_LEGEND", { timeout: 24 * 3600_000 }, () => {
  it("runs R41", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R41 START ${new Date().toISOString()}\n`);

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

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND);
    log(
      `V5_LEGEND base: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
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

    // 41A: very wide volTgt
    log(`\n========== 41A: wider volTgt ==========`);
    for (const tgt of [0.05, 0.06, 0.07, 0.08, 0.1, 0.15]) {
      for (const mult of [3, 5, 8, 10, 15]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
          assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND.assets.map(
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

    // 41B: ADX with maxAdx upper bound
    log(`\n========== 41B: ADX maxAdx upper bound ==========`);
    for (const minAdx of [10, 12, 15]) {
      for (const maxAdx of [40, 50, 60, 80]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
          adxFilter: { period: 14, minAdx, maxAdx },
        };
        maybe(`ADX p=14 m=${minAdx} max=${maxAdx}`, cfg);
      }
    }

    // 41C: ADX period sweep
    log(`\n========== 41C: ADX period deeper ==========`);
    for (const p of [6, 14, 20, 28, 40]) {
      for (const m of [10, 12, 15, 18, 20]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
          adxFilter: { period: p, minAdx: m },
        };
        maybe(`ADX p=${p} m=${m}`, cfg);
      }
    }

    // 41D: drop another asset
    log(`\n========== 41D: drop another asset on LEGEND ==========`);
    for (const sym of FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND.assets.map(
      (a) => a.symbol,
    )) {
      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND.assets.filter(
          (a) => a.symbol !== sym,
        ),
      };
      maybe(`drop ${sym}`, cfg);
    }

    // 41E: LSC re-tune
    log(`\n========== 41E: LSC re-tune ==========`);
    for (const after of [2, 3, 4, 5]) {
      for (const cd of [12, 24, 48, 72, 120, 200]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
          lossStreakCooldown: { afterLosses: after, cooldownBars: cd },
        };
        maybe(`LSC a=${after} cd=${cd}`, cfg);
      }
    }

    // 41F: chandelier re-tune
    log(`\n========== 41F: chandelier re-tune ==========`);
    for (const period of [28, 56, 84, 168]) {
      for (const mult of [1.5, 2, 2.5, 3, 4]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_LEGEND,
          chandelierExit: { period, mult, minMoveR: 0.5 },
        };
        maybe(`chand p=${period} m=${mult}`, cfg);
      }
    }

    log(`\n========== R41 SUMMARY ==========`);
    log(`Wins: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`Top 15:`);
      for (const w of wins.slice(0, 15)) {
        log(
          `  ${w.name.padEnd(45)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R41_BEST.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
