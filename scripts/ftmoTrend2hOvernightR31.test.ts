/**
 * R31 — V5 + volumeFilter / vol+adx combo (multi-fold OOS)
 *
 * volumeFilter is the natural news-proxy: high-impact news cause volume
 * spikes that would blow through our trend trigger.
 *
 * Test on 11 non-overlapping 6mo slices, just like R30.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R31_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

function log(s: string) {
  console.log(s);
  appendFileSync(LOG_FILE, s + "\n");
}

interface BatchResult {
  windows: number;
  passes: number;
  passRate: number;
  medianDays: number;
  p75Days: number;
  p90Days: number;
  tlBreaches: number;
  dlBreaches: number;
  ev: number;
}

function runWalkForward(
  byAsset: Record<string, Candle[]>,
  cfg: FtmoDaytrade24hConfig,
  stepDays = 3,
): BatchResult {
  const winBars = 30 * BARS_PER_DAY;
  const stepBars = stepDays * BARS_PER_DAY;
  const aligned = Math.min(...Object.values(byAsset).map((a) => a.length));
  const out: FtmoDaytrade24hResult[] = [];
  for (let s = 0; s + winBars <= aligned; s += stepBars) {
    const slice: Record<string, Candle[]> = {};
    for (const [sym, arr] of Object.entries(byAsset))
      slice[sym] = arr.slice(s, s + winBars);
    out.push(runFtmoDaytrade24h(slice, cfg));
  }
  const passes = out.filter((r) => r.passed).length;
  const passDays: number[] = [];
  for (const r of out)
    if (r.passed && r.trades.length > 0)
      passDays.push(r.trades[r.trades.length - 1].day + 1);
  passDays.sort((a, b) => a - b);
  const pick = (q: number) => passDays[Math.floor(passDays.length * q)] ?? 0;
  return {
    windows: out.length,
    passes,
    passRate: passes / out.length,
    medianDays: pick(0.5),
    p75Days: pick(0.75),
    p90Days: pick(0.9),
    tlBreaches: out.filter((r) => r.reason === "total_loss").length,
    dlBreaches: out.filter((r) => r.reason === "daily_loss").length,
    ev: (passes / out.length) * 0.5 * 8000 - 99,
  };
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
  "R31 — V5 + volume filter multi-fold",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R31", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R31 START ${new Date().toISOString()}\n`);

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

      // Build 11 non-overlapping 6mo slices
      const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY);
      const numSlices = Math.floor(n / sixMo);
      const slices: Record<string, Candle[]>[] = [];
      for (let i = 0; i < numSlices; i++) {
        const slice: Record<string, Candle[]> = {};
        for (const s of SOURCES)
          slice[s] = data[s].slice(i * sixMo, (i + 1) * sixMo);
        slices.push(slice);
      }
      log(`Built ${slices.length} non-overlapping 6mo slices\n`);

      const evalAcrossSlices = (cfg: FtmoDaytrade24hConfig) => {
        const rates = slices.map((s) => runWalkForward(s, cfg).passRate);
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const min = Math.min(...rates);
        const std = Math.sqrt(
          rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length,
        );
        const recent3 = rates.slice(-3).reduce((a, b) => a + b, 0) / 3;
        return { rates, mean, min, std, recent3 };
      };

      const candidates: { name: string; cfg: FtmoDaytrade24hConfig }[] = [
        { name: "V5 baseline", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
        {
          name: "V5_ROBUST (R30)",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
        },
        {
          name: "V5_RECENT (R30)",
          cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
        },
      ];
      // V5 + volumeFilter sweep
      for (const period of [20, 30, 50, 75, 100, 150]) {
        for (const minRatio of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2]) {
          candidates.push({
            name: `V5 + vol p=${period} r=${minRatio}`,
            cfg: {
              ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
              volumeFilter: { period, minRatio },
            } as FtmoDaytrade24hConfig,
          });
        }
      }
      // Combo: ROBUST + RECENT
      candidates.push({
        name: "V5 + ADX + volFilter (combo)",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
          volatilityFilter: { period: 168, maxAtrFrac: 0.04 },
        } as FtmoDaytrade24hConfig,
      });
      // ROBUST + volume
      candidates.push({
        name: "V5 + ADX + vol r=0.5",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_ROBUST,
          volumeFilter: { period: 50, minRatio: 0.5 },
        } as FtmoDaytrade24hConfig,
      });
      // RECENT + ADX
      candidates.push({
        name: "RECENT + ADX p=10 m=15",
        cfg: {
          ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5_RECENT,
          adxFilter: { period: 10, minAdx: 15 },
        } as FtmoDaytrade24hConfig,
      });

      log(`========== Multi-fold OOS (11 slices) ==========`);
      log(`${"config".padEnd(38)} mean    min     std    recent3`);
      type Res = {
        name: string;
        mean: number;
        min: number;
        std: number;
        recent3: number;
        rates: number[];
      };
      const results: Res[] = [];
      for (const c of candidates) {
        const r = evalAcrossSlices(c.cfg);
        results.push({ name: c.name, ...r });
        log(
          `${c.name.padEnd(38)} ${(r.mean * 100).toFixed(2)}%  ${(r.min * 100).toFixed(2)}%  ${(r.std * 100).toFixed(2)}%  ${(r.recent3 * 100).toFixed(2)}%`,
        );
      }

      log(`\n========== Top 10 by Robustness (mean - 0.5*std) ==========`);
      results.sort((a, b) => b.mean - 0.5 * b.std - (a.mean - 0.5 * a.std));
      for (const r of results.slice(0, 10)) {
        const score = r.mean - 0.5 * r.std;
        log(
          `  ${r.name.padEnd(36)} score=${(score * 100).toFixed(2)}% (mean=${(r.mean * 100).toFixed(2)}% std=${(r.std * 100).toFixed(2)}%)`,
        );
      }

      log(`\n========== Top 10 by Recent-3 ==========`);
      results.sort((a, b) => b.recent3 - a.recent3);
      for (const r of results.slice(0, 10)) {
        log(`  ${r.name.padEnd(36)} recent3=${(r.recent3 * 100).toFixed(2)}%`);
      }

      log(`\n========== Top 10 by Mean ==========`);
      results.sort((a, b) => b.mean - a.mean);
      for (const r of results.slice(0, 10)) {
        log(`  ${r.name.padEnd(36)} mean=${(r.mean * 100).toFixed(2)}%`);
      }

      expect(true).toBe(true);
    });
  },
);
