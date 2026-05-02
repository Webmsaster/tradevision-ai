/**
 * R30 — verify R29 candidates with multiple OOS slices
 *
 * R29 hint: V5 + volatilityFilter{maxAtrFrac=0.05} gave HOLDOUT 47.06% (+6pp).
 * Could be noise (51 windows). Test on 5 different OOS slices.
 *
 * Slices: 5 non-overlapping ~6mo holdouts, sweep across full data.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R30_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  "R30 — multi-fold OOS verification",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R30", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R30 START ${new Date().toISOString()}\n`);

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

      // Build 9 non-overlapping ~6mo slices, sliding through full 5.6y
      const sixMo = Math.floor(0.5 * 365 * BARS_PER_DAY); // ~2190 bars
      const numSlices = Math.floor(n / sixMo); // ~11
      const slices: { name: string; data: Record<string, Candle[]> }[] = [];
      for (let i = 0; i < numSlices; i++) {
        const slice: Record<string, Candle[]> = {};
        for (const s of SOURCES)
          slice[s] = data[s].slice(i * sixMo, (i + 1) * sixMo);
        slices.push({
          name: `slice_${i}_${(i * 0.5).toFixed(1)}-${((i + 1) * 0.5).toFixed(1)}y`,
          data: slice,
        });
      }
      log(`Built ${slices.length} non-overlapping 6mo slices\n`);

      const candidates = [
        { name: "V5 baseline", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
        {
          name: "V5 + vol p=56 max=0.05",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            volatilityFilter: { period: 56, maxAtrFrac: 0.05 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + vol p=168 max=0.05",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            volatilityFilter: { period: 168, maxAtrFrac: 0.05 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + vol p=56 max=0.04",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            volatilityFilter: { period: 56, maxAtrFrac: 0.04 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + vol p=168 max=0.04",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            volatilityFilter: { period: 168, maxAtrFrac: 0.04 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + adx p=10 min=15",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            adxFilter: { period: 10, minAdx: 15 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + LSC a=3 cd=48",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            lossStreakCooldown: { afterLosses: 3, cooldownBars: 48 },
          } as FtmoDaytrade24hConfig,
        },
        {
          name: "V5 + BTC CAF 12/48 skipDown",
          cfg: {
            ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
            crossAssetFilter: {
              symbol: "BTCUSDT",
              emaFastPeriod: 12,
              emaSlowPeriod: 48,
              skipLongsIfSecondaryDowntrend: true,
            },
          } as FtmoDaytrade24hConfig,
        },
      ];

      log(`========== Per-slice pass-rate ==========`);
      log(
        `${"config".padEnd(35)} ${slices.map((s, i) => `s${i}`.padStart(7)).join(" ")} | mean   min`,
      );
      const results: {
        name: string;
        rates: number[];
        mean: number;
        min: number;
        std: number;
      }[] = [];
      for (const c of candidates) {
        const rates = slices.map((s) => runWalkForward(s.data, c.cfg).passRate);
        const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
        const min = Math.min(...rates);
        const variance =
          rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
        const std = Math.sqrt(variance);
        results.push({ name: c.name, rates, mean, min, std });
        log(
          `${c.name.padEnd(35)} ${rates.map((r) => `${(r * 100).toFixed(1).padStart(5)}%`).join(" ")} | ${(mean * 100).toFixed(2)}% ${(min * 100).toFixed(2)}%`,
        );
      }

      log(`\n========== Robustness ranking (mean - 0.5*std) ==========`);
      results.sort((a, b) => b.mean - 0.5 * b.std - (a.mean - 0.5 * a.std));
      for (const r of results) {
        const score = r.mean - 0.5 * r.std;
        log(
          `  ${r.name.padEnd(35)} score=${(score * 100).toFixed(2)}% mean=${(r.mean * 100).toFixed(2)}% min=${(r.min * 100).toFixed(2)}% std=${(r.std * 100).toFixed(2)}%`,
        );
      }

      log(
        `\n========== Recent-3-slices average (most relevant for live) ==========`,
      );
      results.sort((a, b) => {
        const aRecent = a.rates.slice(-3).reduce((x, y) => x + y, 0) / 3;
        const bRecent = b.rates.slice(-3).reduce((x, y) => x + y, 0) / 3;
        return bRecent - aRecent;
      });
      for (const r of results) {
        const recent = r.rates.slice(-3).reduce((x, y) => x + y, 0) / 3;
        log(
          `  ${r.name.padEnd(35)} recent3-mean=${(recent * 100).toFixed(2)}%`,
        );
      }

      expect(true).toBe(true);
    });
  },
);
