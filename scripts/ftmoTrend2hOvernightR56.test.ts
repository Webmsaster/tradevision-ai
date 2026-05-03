/**
 * R56 — expand asset universe: 20+ crypto pairs
 *
 * V5 has 9 assets. Test if adding more diversifies better.
 * Asset list = liquid Binance perp pairs with ≥3y history.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R56_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

const CORE_9 = [
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
const EXTRAS = [
  "XRPUSDT",
  "TRXUSDT",
  "ATOMUSDT",
  "DOTUSDT",
  "MATICUSDT",
  "NEARUSDT",
  "FILUSDT",
  "ETCUSDT",
  "XLMUSDT",
  "ALGOUSDT",
  "VETUSDT",
  "EOSUSDT",
];

function trendAsset(s: string): Daytrade24hAssetCfg {
  return {
    symbol: `${s.replace("USDT", "")}-TREND`,
    sourceSymbol: s,
    costBp: 30,
    slippageBp: 8,
    swapBpPerDay: 4,
    riskFrac: 1.0,
    triggerBars: 1,
    invertDirection: true,
    disableShort: true,
    stopPct: 0.05,
    tpPct: 0.07,
    holdBars: 240,
  };
}

describe("R56 — bigger crypto universe", { timeout: 24 * 3600_000 }, () => {
  it("runs R56", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R56 START ${new Date().toISOString()}\n`);

    const allSymbols = [...CORE_9, ...EXTRAS];
    const data: Record<string, Candle[]> = {};
    log(`Loading 2h data for ${allSymbols.length} assets...`);
    for (const s of allSymbols) {
      try {
        data[s] = await loadBinanceHistory({
          symbol: s,
          timeframe: "2h",
          targetCount: 30000,
          maxPages: 40,
        });
        const yrs = (data[s].length / BARS_PER_DAY / 365).toFixed(2);
        log(`  ${s}: ${data[s].length} bars (${yrs}y)`);
      } catch (e) {
        log(`  ${s}: FAIL ${(e as Error).message}`);
      }
    }
    const eligible = Object.keys(data).filter((s) => data[s].length >= 24000); // ≥5.5y
    log(`\nEligible (≥5.5y): ${eligible.join(", ")}`);

    const n = Math.min(...eligible.map((s) => data[s].length));
    for (const s of eligible) data[s] = data[s].slice(-n);
    log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

    const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
    const numSlices = Math.floor(n / sixMo);

    function evalCfg(
      cfg: FtmoDaytrade24hConfig,
      dataView: Record<string, Candle[]>,
    ) {
      const winBars = 30 * BARS_PER_DAY;
      const stepBars = 3 * BARS_PER_DAY;
      // Single-eval (honest aggregate)
      let p = 0,
        w = 0,
        tl = 0;
      const aligned = Math.min(...Object.values(dataView).map((c) => c.length));
      const passDays: number[] = [];
      for (let s = 0; s + winBars <= aligned; s += stepBars) {
        const sub: Record<string, Candle[]> = {};
        for (const [sym, arr] of Object.entries(dataView))
          sub[sym] = arr.slice(s, s + winBars);
        const r = runFtmoDaytrade24h(sub, cfg);
        if (r.passed) {
          p++;
          if (r.trades.length > 0)
            passDays.push(r.trades[r.trades.length - 1].day + 1);
        }
        if (r.reason === "total_loss") tl++;
        w++;
      }
      passDays.sort((a, b) => a - b);
      const pick = (q: number) =>
        passDays[Math.floor(passDays.length * q)] ?? 0;
      // Multi-fold
      const slicePassRates: number[] = [];
      for (let si = 0; si < numSlices; si++) {
        let sp = 0,
          sw = 0;
        const sliceStart = si * sixMo;
        const sliceEnd = (si + 1) * sixMo;
        for (let s = sliceStart; s + winBars <= sliceEnd; s += stepBars) {
          const sub: Record<string, Candle[]> = {};
          for (const [sym, arr] of Object.entries(dataView))
            sub[sym] = arr.slice(s, s + winBars);
          const r = runFtmoDaytrade24h(sub, cfg);
          if (r.passed) sp++;
          sw++;
        }
        slicePassRates.push(sw > 0 ? sp / sw : 0);
      }
      const mfMean =
        slicePassRates.reduce((a, b) => a + b, 0) / slicePassRates.length;
      const mfMin = Math.min(...slicePassRates);
      return {
        single: p / w,
        tlRate: tl / w,
        windows: w,
        engineMed: pick(0.5),
        engineP90: pick(0.9),
        mfMean,
        mfMin,
      };
    }

    // Build configs with varying asset counts
    const baseAssets = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5.assets;
    const baseV5 = FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5;
    const dataView9: Record<string, Candle[]> = {};
    for (const s of CORE_9) if (eligible.includes(s)) dataView9[s] = data[s];

    const r9 = evalCfg(baseV5, dataView9);
    log(`V5 baseline (9 assets):`);
    log(
      `  Single-eval: ${(r9.single * 100).toFixed(2)}% (${r9.windows}w) TL=${(r9.tlRate * 100).toFixed(2)}% engineMed=${r9.engineMed}d engineP90=${r9.engineP90}d`,
    );
    log(
      `  Multi-fold:  mean=${(r9.mfMean * 100).toFixed(2)}% min=${(r9.mfMin * 100).toFixed(2)}%`,
    );

    // Greedy add eligible extras
    log(`\n========== Greedy add extras to V5 ==========`);
    const extraEligible = EXTRAS.filter((s) => eligible.includes(s));
    log(`Available extras: ${extraEligible.join(", ")}\n`);

    let curCfg = baseV5;
    let curView = { ...dataView9 };
    let curR = r9;
    let added: string[] = [];

    for (let iter = 0; iter < 12; iter++) {
      let stepBest: {
        sym: string;
        cfg: FtmoDaytrade24hConfig;
        view: Record<string, Candle[]>;
        r: typeof r9;
      } | null = null;
      const remaining = extraEligible.filter((s) => !added.includes(s));
      if (remaining.length === 0) break;
      for (const sym of remaining) {
        const newAssets = [...curCfg.assets, trendAsset(sym)];
        const newCfg = { ...curCfg, assets: newAssets };
        const newView = { ...curView, [sym]: data[sym] };
        const r = evalCfg(newCfg, newView);
        if (r.single > curR.single) {
          if (stepBest === null || r.single > stepBest.r.single)
            stepBest = { sym, cfg: newCfg, view: newView, r };
        }
      }
      if (!stepBest) {
        log(`  No further add helps. Stop.`);
        break;
      }
      curCfg = stepBest.cfg;
      curView = stepBest.view;
      curR = stepBest.r;
      added.push(stepBest.sym);
      log(
        `  +${stepBest.sym}: single=${(stepBest.r.single * 100).toFixed(2)}% TL=${(stepBest.r.tlRate * 100).toFixed(2)}% mfMean=${(stepBest.r.mfMean * 100).toFixed(2)}% engineP90=${stepBest.r.engineP90}d  (assets: ${curCfg.assets.length})`,
      );
    }

    log(`\n========== R56 SUMMARY ==========`);
    log(
      `V5 baseline (9 assets):  single=${(r9.single * 100).toFixed(2)}% mfMean=${(r9.mfMean * 100).toFixed(2)}% TL=${(r9.tlRate * 100).toFixed(2)}%`,
    );
    log(`V5 + ${added.length} extras (${added.join("+") || "none"}):`);
    log(
      `  single=${(curR.single * 100).toFixed(2)}% mfMean=${(curR.mfMean * 100).toFixed(2)}% TL=${(curR.tlRate * 100).toFixed(2)}% engineMed=${curR.engineMed}d engineP90=${curR.engineP90}d`,
    );
    log(`  Δ: +${((curR.single - r9.single) * 100).toFixed(2)}pp single`);

    if (added.length > 0) {
      writeFileSync(
        `${LOG_DIR}/R56_BEST.json`,
        JSON.stringify({ added, cfg: curCfg }, null, 2),
      );
    }

    expect(true).toBe(true);
  });
});
