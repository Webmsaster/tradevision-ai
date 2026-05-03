/**
 * R24 — out-of-sample validation + simulated annealing on V12
 *
 * 24A: split 5.59y into TRAIN (first 70%) + TEST (last 30%)
 *      Run all V5..V13 on each half. Check if V12 gain holds OOS.
 * 24B: small random perturbations of V12 (sim. annealing temp 0.1)
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R24_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(40)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches.toString().padStart(2)} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
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
  "R24 — OOS validation + sim. annealing",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R24", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R24 START ${new Date().toISOString()}\n`);

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
      log(`Aligned: ${n} bars (${(n / BARS_PER_DAY / 365).toFixed(2)}y)\n`);

      // Split into TRAIN (first 70%) and TEST (last 30%)
      const splitIdx = Math.floor(n * 0.7);
      const train: Record<string, Candle[]> = {};
      const test: Record<string, Candle[]> = {};
      for (const s of SOURCES) {
        train[s] = data[s].slice(0, splitIdx);
        test[s] = data[s].slice(splitIdx);
      }
      log(
        `TRAIN: ${splitIdx} bars (${(splitIdx / BARS_PER_DAY / 365).toFixed(2)}y)`,
      );
      log(
        `TEST:  ${n - splitIdx} bars (${((n - splitIdx) / BARS_PER_DAY / 365).toFixed(2)}y)\n`,
      );

      log(`========== 24A: V5/V8/V12 OOS ==========`);
      const configs = [
        { name: "V5", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5 },
        { name: "V8", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8 },
        { name: "V12", cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12 },
      ];
      log(`\nTRAIN (in-sample):`);
      const trainResults: BatchResult[] = [];
      for (const c of configs) {
        const r = runWalkForward(train, c.cfg);
        trainResults.push(r);
        log(fmt(`  ${c.name}`, r));
      }
      log(`\nTEST (out-of-sample):`);
      const testResults: BatchResult[] = [];
      for (const c of configs) {
        const r = runWalkForward(test, c.cfg);
        testResults.push(r);
        log(fmt(`  ${c.name}`, r));
      }
      log(`\nGENERALIZATION (TEST - TRAIN, pp):`);
      for (let i = 0; i < configs.length; i++) {
        const d = (testResults[i].passRate - trainResults[i].passRate) * 100;
        log(
          `  ${configs[i].name}: ${d > 0 ? "+" : ""}${d.toFixed(2)}pp  (TRAIN: ${(trainResults[i].passRate * 100).toFixed(2)}% → TEST: ${(testResults[i].passRate * 100).toFixed(2)}%)`,
        );
      }

      // 24B: simulated annealing — small perturbations of V12
      log(`\n========== 24B: V12 simulated annealing on FULL data ==========`);
      let cur = JSON.parse(
        JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12),
      ) as FtmoDaytrade24hConfig;
      const baseR = runWalkForward(data, cur);
      log(fmt("V12 base full", baseR));

      let best = { cfg: cur, r: baseR };
      for (let trial = 0; trial < 500; trial++) {
        // Pick ONE param to perturb slightly
        const mutation = Math.floor(Math.random() * 8);
        const cfg: FtmoDaytrade24hConfig = JSON.parse(JSON.stringify(best.cfg));
        switch (mutation) {
          case 0: // ADX period ±2
            if (cfg.adxFilter)
              cfg.adxFilter = {
                ...cfg.adxFilter,
                period: Math.max(
                  4,
                  cfg.adxFilter.period + Math.floor(Math.random() * 7) - 3,
                ),
              };
            break;
          case 1: // chand mult ±0.25
            if (cfg.chandelierExit)
              cfg.chandelierExit = {
                ...cfg.chandelierExit,
                mult: Math.max(
                  1,
                  cfg.chandelierExit.mult + (Math.random() * 0.5 - 0.25),
                ),
              };
            break;
          case 2: // chop maxCi ±5
            if (cfg.choppinessFilter)
              cfg.choppinessFilter = {
                ...cfg.choppinessFilter,
                maxCi: Math.max(
                  50,
                  Math.min(
                    85,
                    (cfg.choppinessFilter.maxCi ?? 72) +
                      (Math.random() * 10 - 5),
                  ),
                ),
              };
            break;
          case 3: // LSC cooldown ±12
            if (cfg.lossStreakCooldown)
              cfg.lossStreakCooldown = {
                ...cfg.lossStreakCooldown,
                cooldownBars: Math.max(
                  6,
                  cfg.lossStreakCooldown.cooldownBars +
                    Math.floor(Math.random() * 25) -
                    12,
                ),
              };
            break;
          case 4: // BTC CAF mb ±6
            if (cfg.crossAssetFilter)
              cfg.crossAssetFilter = {
                ...cfg.crossAssetFilter,
                momentumBars: Math.max(
                  4,
                  (cfg.crossAssetFilter.momentumBars ?? 24) +
                    Math.floor(Math.random() * 13) -
                    6,
                ),
              };
            break;
          case 5: // volume r ±0.1
            if (cfg.volumeFilter)
              cfg.volumeFilter = {
                ...cfg.volumeFilter,
                minRatio: Math.max(
                  0.1,
                  Math.min(
                    1.5,
                    cfg.volumeFilter.minRatio + (Math.random() * 0.2 - 0.1),
                  ),
                ),
              };
            break;
          case 6: // trail tr ±0.001
            if (cfg.trailingStop)
              cfg.trailingStop = {
                ...cfg.trailingStop,
                trailPct: Math.max(
                  0.0005,
                  cfg.trailingStop.trailPct + (Math.random() * 0.002 - 0.001),
                ),
              };
            break;
          case 7: // HTF threshold ±0.02
            if (cfg.htfTrendFilter)
              cfg.htfTrendFilter = {
                ...cfg.htfTrendFilter,
                threshold:
                  (cfg.htfTrendFilter.threshold ?? 0) +
                  (Math.random() * 0.04 - 0.02),
              };
            break;
        }
        const r = runWalkForward(data, cfg);
        if (
          r.passRate > best.r.passRate ||
          (r.passRate === best.r.passRate && r.tlBreaches < best.r.tlBreaches)
        ) {
          best = { cfg, r };
          log(fmt(`  *** trial ${trial} (mut ${mutation}) BEST`, r));
        }
      }
      log(fmt(`24B WINNER`, best.r));
      if (
        best.r.passRate > baseR.passRate ||
        best.r.tlBreaches < baseR.tlBreaches
      ) {
        writeFileSync(
          `${LOG_DIR}/R24_FINAL_CONFIG.json`,
          JSON.stringify(best.cfg, null, 2),
        );
      }

      expect(true).toBe(true);
    });
  },
);
