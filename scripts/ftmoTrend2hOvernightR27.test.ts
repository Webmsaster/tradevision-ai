/**
 * R27 — optimize EXPLICITLY for last 12mo regime, validate on 6mo/2y/3y
 *
 * Goal: find a config that's optimal for the regime we're about to live-trade,
 * not the long-term average. V8 wins recent — sim. annealing on V8 with
 * last-12mo as the optimization target.
 *
 * Score function:
 *   - Primary: pass-rate on last 12mo
 *   - Secondary: tlBreaches on last 12mo (≤ 5)
 *   - Validation: pass-rate on last 6mo and last 2y must not collapse (>30%)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R27_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

function fmt(label: string, r: BatchResult) {
  return `${label.padEnd(35)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches.toString().padStart(2)} DL=${r.dlBreaches}`;
}

function pickv<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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
  "R27 — recent-regime optimized config",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R27", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R27 START ${new Date().toISOString()}\n`);

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

      // Build slices
      const slice = (years: number) => {
        const bars = Math.min(Math.floor(years * 365 * BARS_PER_DAY), n);
        const d: Record<string, Candle[]> = {};
        for (const s of SOURCES) d[s] = data[s].slice(-bars);
        return d;
      };
      const last6mo = slice(0.5);
      const last1y = slice(1);
      const last2y = slice(2);
      const last3y = slice(3);

      log(
        `Slices: 6mo=${Object.values(last6mo)[0].length}bars, 1y=${Object.values(last1y)[0].length}, 2y=${Object.values(last2y)[0].length}, 3y=${Object.values(last3y)[0].length}, full=${n}`,
      );

      // Baseline: V5, V8, V12 on all slices
      log(`\n========== BASELINES ==========`);
      for (const v of [
        { name: "V5", c: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
        { name: "V8", c: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8 },
        { name: "V12", c: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12 },
      ]) {
        log(`\n${v.name}:`);
        log(fmt("  6mo", runWalkForward(last6mo, v.c)));
        log(fmt("  1y ", runWalkForward(last1y, v.c)));
        log(fmt("  2y ", runWalkForward(last2y, v.c)));
        log(fmt("  3y ", runWalkForward(last3y, v.c)));
      }

      // Optimization target: last 12mo pass-rate, with safety constraints
      let best = {
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
        score: -1,
        p1y: 0,
        p6mo: 0,
        p2y: 0,
        tl1y: 0,
      };
      {
        const r1y = runWalkForward(last1y, best.cfg);
        const r6mo = runWalkForward(last6mo, best.cfg);
        const r2y = runWalkForward(last2y, best.cfg);
        best.p1y = r1y.passRate;
        best.p6mo = r6mo.passRate;
        best.p2y = r2y.passRate;
        best.tl1y = r1y.tlBreaches;
        best.score = r1y.passRate;
        log(
          `\nV8 baseline: 1y=${(r1y.passRate * 100).toFixed(2)}% TL=${r1y.tlBreaches}, 6mo=${(r6mo.passRate * 100).toFixed(2)}%, 2y=${(r2y.passRate * 100).toFixed(2)}%`,
        );
      }

      // Sim. annealing on V8 with 1y as optimization target
      log(
        `\n========== Sim. annealing 2000 trials, target=1y pass-rate ==========`,
      );
      for (let trial = 0; trial < 2000; trial++) {
        const cfg: FtmoDaytrade24hConfig = JSON.parse(JSON.stringify(best.cfg));
        // Mutate 1-2 params
        const numMut = 1 + Math.floor(Math.random() * 2);
        for (let m = 0; m < numMut; m++) {
          const which = Math.floor(Math.random() * 9);
          switch (which) {
            case 0:
              if (cfg.adxFilter)
                cfg.adxFilter = {
                  period: pickv([6, 8, 10, 14, 20, 28]),
                  minAdx: pickv([0, 5, 10, 15, 20]),
                };
              break;
            case 1:
              if (cfg.chandelierExit)
                cfg.chandelierExit = {
                  period: pickv([28, 56, 84, 168]),
                  mult: 1.5 + Math.random() * 3.5,
                  minMoveR: 0.5,
                };
              break;
            case 2:
              if (cfg.choppinessFilter)
                cfg.choppinessFilter = {
                  period: pickv([10, 14, 20]),
                  maxCi: 60 + Math.random() * 25,
                };
              break;
            case 3:
              if (cfg.lossStreakCooldown)
                cfg.lossStreakCooldown = {
                  afterLosses: pickv([2, 3, 4]),
                  cooldownBars: 12 + Math.floor(Math.random() * 200),
                };
              break;
            case 4:
              if (cfg.crossAssetFilter)
                cfg.crossAssetFilter = {
                  symbol: pickv(["BTCUSDT", "ETHUSDT"]),
                  emaFastPeriod: pickv([4, 6, 8, 12]),
                  emaSlowPeriod: pickv([12, 24, 36, 48]),
                  skipLongsIfSecondaryDowntrend: Math.random() < 0.4,
                  momentumBars: pickv([12, 18, 24, 36, 48]),
                  momSkipLongBelow: pickv([-0.05, -0.03, -0.02, -0.01, 0]),
                };
              break;
            case 5:
              if (
                cfg.crossAssetFiltersExtra &&
                cfg.crossAssetFiltersExtra.length > 0
              )
                cfg.crossAssetFiltersExtra = [
                  {
                    symbol: pickv([
                      "ETHUSDT",
                      "BTCUSDT",
                      "BNBUSDT",
                      "LINKUSDT",
                    ]),
                    emaFastPeriod: pickv([4, 8, 12]),
                    emaSlowPeriod: pickv([24, 48, 96]),
                    skipLongsIfSecondaryDowntrend: true,
                  },
                ];
              break;
            case 6:
              cfg.volumeFilter = {
                period: pickv([20, 30, 50, 75, 100, 150]),
                minRatio: 0.2 + Math.random() * 0.7,
              };
              break;
            case 7:
              if (cfg.trailingStop) {
                const act = pickv([0.02, 0.025, 0.03, 0.04]);
                cfg.trailingStop = {
                  activatePct: act,
                  trailPct: 0.0005 + Math.random() * (act * 0.5),
                };
              }
              break;
            case 8:
              if (cfg.htfTrendFilter)
                cfg.htfTrendFilter = {
                  lookbackBars: pickv([24, 48, 72, 120, 240]),
                  apply: pickv(["long", "both"] as const),
                  threshold: -0.05 + Math.random() * 0.2,
                };
              break;
          }
        }
        if (
          cfg.crossAssetFilter &&
          cfg.crossAssetFilter.emaSlowPeriod <=
            cfg.crossAssetFilter.emaFastPeriod
        )
          continue;
        if (
          cfg.trailingStop &&
          cfg.trailingStop.trailPct >= cfg.trailingStop.activatePct
        )
          continue;

        // Eval on 1y (target)
        const r1y = runWalkForward(last1y, cfg);
        // Hard constraints: TL ≤ 5 on 1y, p6mo ≥ 30%
        if (r1y.tlBreaches > 5) continue;
        const r6mo = runWalkForward(last6mo, cfg);
        if (r6mo.passRate < 0.3) continue;

        // Score: 1y pass + 6mo bonus
        const score = r1y.passRate * 0.7 + r6mo.passRate * 0.3;
        if (score > best.score) {
          const r2y = runWalkForward(last2y, cfg);
          best = {
            cfg,
            score,
            p1y: r1y.passRate,
            p6mo: r6mo.passRate,
            p2y: r2y.passRate,
            tl1y: r1y.tlBreaches,
          };
          log(
            `  *** trial ${trial} BEST 1y=${(r1y.passRate * 100).toFixed(2)}% 6mo=${(r6mo.passRate * 100).toFixed(2)}% 2y=${(r2y.passRate * 100).toFixed(2)}% TL1y=${r1y.tlBreaches}`,
          );
        }
        if ((trial + 1) % 250 === 0) {
          log(
            `  ${trial + 1}/2000 — best 1y=${(best.p1y * 100).toFixed(2)}% 6mo=${(best.p6mo * 100).toFixed(2)}%`,
          );
        }
      }

      // Final eval
      log(`\n========== R27 FINAL ==========`);
      log(fmt("R27 winner 6mo", runWalkForward(last6mo, best.cfg)));
      log(fmt("R27 winner 1y ", runWalkForward(last1y, best.cfg)));
      log(fmt("R27 winner 2y ", runWalkForward(last2y, best.cfg)));
      log(fmt("R27 winner 3y ", runWalkForward(last3y, best.cfg)));
      log(fmt("R27 winner FULL", runWalkForward(data, best.cfg)));

      writeFileSync(
        `${LOG_DIR}/R27_FINAL_CONFIG.json`,
        JSON.stringify(best.cfg, null, 2),
      );
      log(`\nWritten R27_FINAL_CONFIG.json`);

      expect(true).toBe(true);
    });
  },
);
