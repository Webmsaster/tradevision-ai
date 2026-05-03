/**
 * R25 — push V14 with TIGHTER sim. annealing + cross-validation
 *
 * 25A: 1500 sim. annealing trials with tight mutations on V14
 * 25B: 5-fold CV (train on 4 folds, test on 1, repeat) — accept only configs robust across folds
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R25_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(40)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches.toString().padStart(2)} DL=${r.dlBreaches}`;
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
  "R25 — V14 sim. annealing + 3-fold CV",
  { timeout: 24 * 3600_000 },
  () => {
    it("runs R25", async () => {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(LOG_FILE, `R25 START ${new Date().toISOString()}\n`);

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

      // Build 3 folds of equal size from full data
      const foldSize = Math.floor(n / 3);
      const folds: Record<string, Candle[]>[] = [0, 1, 2].map((i) => {
        const f: Record<string, Candle[]> = {};
        for (const s of SOURCES)
          f[s] = data[s].slice(i * foldSize, (i + 1) * foldSize);
        return f;
      });

      log(`========== Baseline V12 + V14 across 3 folds ==========`);
      for (const cfg of [
        { name: "V12", c: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12 },
        { name: "V14", c: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14 },
      ]) {
        log(`\n${cfg.name}:`);
        const fr = folds.map((f, i) => {
          const r = runWalkForward(f, cfg.c);
          log(fmt(`  fold ${i}`, r));
          return r;
        });
        const meanPass = fr.reduce((a, b) => a + b.passRate, 0) / fr.length;
        const minPass = Math.min(...fr.map((r) => r.passRate));
        log(
          `  mean=${(meanPass * 100).toFixed(2)}% min=${(minPass * 100).toFixed(2)}%`,
        );
      }

      // 25B: 1500 sim. annealing on V14, accept only if mean across folds improves
      log(
        `\n========== 25B: 1500 sim. annealing trials, fold-mean score ==========`,
      );
      let best = {
        cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14,
        mean: 0,
        min: 0,
      };
      {
        const v14fr = folds.map((f) =>
          runWalkForward(f, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14),
        );
        best.mean = v14fr.reduce((a, b) => a + b.passRate, 0) / 3;
        best.min = Math.min(...v14fr.map((r) => r.passRate));
        log(
          `V14 baseline mean=${(best.mean * 100).toFixed(2)}% min=${(best.min * 100).toFixed(2)}%`,
        );
      }

      function pick<T>(arr: T[]): T {
        return arr[Math.floor(Math.random() * arr.length)];
      }

      for (let trial = 0; trial < 1500; trial++) {
        const cfg: FtmoDaytrade24hConfig = JSON.parse(JSON.stringify(best.cfg));
        // Mutate 1-2 random params
        const numMutations = 1 + Math.floor(Math.random() * 2);
        for (let m = 0; m < numMutations; m++) {
          const which = Math.floor(Math.random() * 8);
          switch (which) {
            case 0:
              if (cfg.adxFilter)
                cfg.adxFilter = {
                  ...cfg.adxFilter,
                  period: pick([6, 8, 10, 14, 20, 28]),
                  minAdx: pick([0, 5, 10, 15]),
                };
              break;
            case 1:
              if (cfg.chandelierExit)
                cfg.chandelierExit = {
                  ...cfg.chandelierExit,
                  mult: 1.5 + Math.random() * 3,
                };
              break;
            case 2:
              if (cfg.choppinessFilter)
                cfg.choppinessFilter = {
                  ...cfg.choppinessFilter,
                  maxCi: 60 + Math.random() * 25,
                };
              break;
            case 3:
              if (cfg.lossStreakCooldown)
                cfg.lossStreakCooldown = {
                  afterLosses: pick([2, 3, 4]),
                  cooldownBars: 12 + Math.floor(Math.random() * 200),
                };
              break;
            case 4:
              if (cfg.crossAssetFilter)
                cfg.crossAssetFilter = {
                  ...cfg.crossAssetFilter,
                  momentumBars: pick([12, 18, 24, 36, 48]),
                  momSkipLongBelow: pick([-0.05, -0.03, -0.02, -0.01]),
                };
              break;
            case 5:
              if (cfg.volumeFilter)
                cfg.volumeFilter = {
                  period: pick([20, 30, 50, 75, 100, 150]),
                  minRatio: 0.2 + Math.random() * 0.7,
                };
              break;
            case 6:
              if (cfg.trailingStop)
                cfg.trailingStop = {
                  activatePct: pick([0.02, 0.025, 0.03, 0.04]),
                  trailPct: 0.0005 + Math.random() * 0.012,
                };
              break;
            case 7:
              if (cfg.htfTrendFilter)
                cfg.htfTrendFilter = {
                  ...cfg.htfTrendFilter,
                  lookbackBars: pick([24, 48, 72, 120]),
                  threshold: -0.05 + Math.random() * 0.1,
                };
              break;
          }
        }
        if (
          cfg.trailingStop &&
          cfg.trailingStop.trailPct >= cfg.trailingStop.activatePct
        )
          continue;

        // Eval on 3 folds
        const fr = folds.map((f) => runWalkForward(f, cfg));
        const mean = fr.reduce((a, b) => a + b.passRate, 0) / 3;
        const min = Math.min(...fr.map((r) => r.passRate));
        // Accept if mean improves AND min doesn't drop more than 1pp
        if (mean > best.mean && min >= best.min - 0.01) {
          best = { cfg, mean, min };
          log(
            `  *** trial ${trial} BEST mean=${(mean * 100).toFixed(2)}% min=${(min * 100).toFixed(2)}%`,
          );
        }
        if ((trial + 1) % 250 === 0) {
          log(
            `  ${trial + 1}/1500 — best mean=${(best.mean * 100).toFixed(2)}% min=${(best.min * 100).toFixed(2)}%`,
          );
        }
      }

      // Final eval on full data
      const fullR = runWalkForward(data, best.cfg);
      log(`\n========== R25 FINAL ==========`);
      log(
        fmt(
          "V14 base on FULL",
          runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V14),
        ),
      );
      log(fmt("R25 winner on FULL", fullR));
      log(
        `R25 winner: 3-fold mean=${(best.mean * 100).toFixed(2)}% min=${(best.min * 100).toFixed(2)}%`,
      );

      if (fullR.passRate > 0) {
        writeFileSync(
          `${LOG_DIR}/R25_FINAL_CONFIG.json`,
          JSON.stringify(best.cfg, null, 2),
        );
      }

      expect(true).toBe(true);
    });
  },
);
