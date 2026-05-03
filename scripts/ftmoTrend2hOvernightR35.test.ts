/**
 * R35 — TRY EVERYTHING on V5_ELITE base
 *
 * 35A: news blackout (synthetic FOMC/CPI/NFP)
 * 35B: per-asset funding thresholds
 * 35C: htfTrendFilterAux (macro confluence — different lookback)
 * 35D: per-asset volTargeting (existing engine field)
 * 35E: cross-asset filter — total market dominance hedge
 * 35F: combine all winners
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ULTRA,
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
const LOG_FILE = `${LOG_DIR}/R35_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R35 — try everything", { timeout: 24 * 3600_000 }, () => {
  it("runs R35", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R35 START ${new Date().toISOString()}\n`);

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

    function evalCfg(cfg: FtmoDaytrade24hConfig, useFunding = true) {
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
      return { rates, mean, min, std, recent3, score: mean - 0.5 * std };
    }

    const baseR = evalCfg(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE);
    log(
      `\nV5_ELITE baseline: mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% std=${(baseR.std * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}% SCORE=${(baseR.score * 100).toFixed(2)}%`,
    );

    const wins: {
      name: string;
      cfg: FtmoDaytrade24hConfig;
      score: number;
      mean: number;
      min: number;
      recent3: number;
    }[] = [];
    function maybeWin(name: string, cfg: FtmoDaytrade24hConfig) {
      const r = evalCfg(cfg);
      const tag = r.score > baseR.score ? "🚀" : "·";
      log(
        `  ${tag} ${name.padEnd(40)} mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% std=${(r.std * 100).toFixed(2)}% recent3=${(r.recent3 * 100).toFixed(2)}% score=${(r.score * 100).toFixed(2)}%`,
      );
      if (r.score > baseR.score)
        wins.push({
          name,
          cfg,
          score: r.score,
          mean: r.mean,
          min: r.min,
          recent3: r.recent3,
        });
    }

    // 35A: News blackout
    log(`\n========== 35A: news blackout (FOMC+CPI+NFP+PPI) ==========`);
    const events = getMacroEvents();
    log(`${events.length} events generated`);
    for (const buf of [15, 30, 60, 120, 240]) {
      maybeWin(`news bufMin=${buf}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
        newsFilter: { events, bufferMinutes: buf },
      });
    }

    // 35B: per-asset funding (override DOGE which has higher baseline)
    log(`\n========== 35B: per-asset funding ==========`);
    // ELITE has cfg.fundingRateFilter.maxFundingForLong=0.001 globally
    // Override per asset based on asset's typical funding distribution
    for (const altMax of [0.0008, 0.0012, 0.0015, 0.002]) {
      maybeWin(`DOGE-only maxFL=${altMax}`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
        assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.assets.map((a) =>
          a.symbol === "DOGE-TREND" ? { ...a, maxFundingForLong: altMax } : a,
        ),
      });
    }
    // Loose funding for "trend coins" (BTC tighter, others looser)
    maybeWin(`BTC-tight ETH-loose`, {
      ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
      assets: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.assets.map((a) => {
        if (a.symbol === "BTC-TREND")
          return { ...a, maxFundingForLong: 0.0005 };
        if (a.symbol === "ETH-TREND")
          return { ...a, maxFundingForLong: 0.0015 };
        return a;
      }),
    });

    // 35C: htfTrendFilterAux (macro confluence — different lookback than primary HTF)
    log(`\n========== 35C: htfTrendFilterAux (macro) ==========`);
    for (const lb of [120, 240, 360, 500]) {
      for (const thr of [-0.05, 0, 0.05, 0.1]) {
        maybeWin(`HTFAux lb=${lb} thr=${thr}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
          htfTrendFilterAux: {
            lookbackBars: lb,
            apply: "long",
            threshold: thr,
          },
        });
      }
    }

    // 35D: per-asset volTargeting
    log(`\n========== 35D: per-asset volTargeting ==========`);
    for (const target of [0.02, 0.025, 0.03] as const) {
      for (const maxMult of [1.5, 2.0, 3.0] as const) {
        maybeWin(`volTgt all=${target} maxMult=${maxMult}`, {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
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
        });
      }
    }

    // 35E: BNB as second cross-asset extra (or ADA, LINK as confluence)
    log(`\n========== 35E: triple cross-asset gate ==========`);
    for (const sym of ["BNBUSDT", "LINKUSDT", "ADAUSDT"]) {
      maybeWin(`+CAF extra ${sym} 4/48`, {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE,
        crossAssetFiltersExtra: [
          ...(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ELITE.crossAssetFiltersExtra ??
            []),
          {
            symbol: sym,
            emaFastPeriod: 4,
            emaSlowPeriod: 48,
            skipLongsIfSecondaryDowntrend: true,
          },
        ],
      });
    }

    // 35F: combinations of any winners (auto-stack top 2-3)
    log(`\n========== 35F: combinations ==========`);
    if (wins.length >= 2) {
      wins.sort((a, b) => b.score - a.score);
      // Stack top 2
      const top1 = wins[0];
      const top2 = wins[1];
      log(
        `Top winners: ${top1.name} (${(top1.score * 100).toFixed(2)}%), ${top2.name} (${(top2.score * 100).toFixed(2)}%)`,
      );
      // Note: just simple stacking by merging cfg
      const combo: FtmoDaytrade24hConfig = {
        ...top1.cfg,
        ...top2.cfg,
      } as FtmoDaytrade24hConfig;
      // Properly merge crossAssetFiltersExtra arrays
      if (top1.cfg.crossAssetFiltersExtra && top2.cfg.crossAssetFiltersExtra) {
        combo.crossAssetFiltersExtra = [
          ...top1.cfg.crossAssetFiltersExtra,
          ...top2.cfg.crossAssetFiltersExtra,
        ];
      }
      maybeWin(`COMBO top1+top2`, combo);
    } else {
      log(`Not enough winners to combine (${wins.length})`);
    }

    log(`\n========== R35 SUMMARY ==========`);
    log(
      `Baseline V5_ELITE: score=${(baseR.score * 100).toFixed(2)}% mean=${(baseR.mean * 100).toFixed(2)}% min=${(baseR.min * 100).toFixed(2)}% recent3=${(baseR.recent3 * 100).toFixed(2)}%`,
    );
    log(`Wins above baseline: ${wins.length}`);
    if (wins.length > 0) {
      wins.sort((a, b) => b.score - a.score);
      log(`\nTop 10 by score:`);
      for (const w of wins.slice(0, 10)) {
        log(
          `  ${w.name.padEnd(40)} score=${(w.score * 100).toFixed(2)}% mean=${(w.mean * 100).toFixed(2)}% min=${(w.min * 100).toFixed(2)}% recent3=${(w.recent3 * 100).toFixed(2)}%`,
        );
      }
      writeFileSync(
        `${LOG_DIR}/R35_TOP_CONFIG.json`,
        JSON.stringify(wins[0].cfg, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
