/**
 * R28 — proper OOS validation of V15 approach
 *
 * V15 was optimized using last 6mo and 1y as targets — so its scores
 * on those periods are TRAIN, not OOS.
 *
 * Test: optimize on data EXCLUDING last 6mo. Validate on last 6mo holdout.
 * If pass-rate ≥ V8's 35.29% on holdout, the approach generalizes.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R28_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(30)} ${r.passes.toString().padStart(3)}/${String(r.windows).padStart(3)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches}`;
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

describe("R28 — V15 honest OOS validation", { timeout: 24 * 3600_000 }, () => {
  it("runs R28", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R28 START ${new Date().toISOString()}\n`);

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

    const sixMoBars = Math.floor(0.5 * 365 * BARS_PER_DAY);
    const train: Record<string, Candle[]> = {};
    const holdout: Record<string, Candle[]> = {};
    for (const s of SOURCES) {
      train[s] = data[s].slice(0, n - sixMoBars);
      holdout[s] = data[s].slice(n - sixMoBars);
    }
    log(`TRAIN: ${Object.values(train)[0].length} bars (excludes last 6mo)`);
    log(`HOLDOUT: ${Object.values(holdout)[0].length} bars (last 6mo)\n`);

    log(`========== Baselines on HOLDOUT (truly OOS for V15) ==========`);
    log(
      fmt(
        "V5 holdout",
        runWalkForward(holdout, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5),
      ),
    );
    log(
      fmt(
        "V8 holdout",
        runWalkForward(holdout, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8),
      ),
    );
    log(
      fmt(
        "V12 holdout",
        runWalkForward(holdout, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12),
      ),
    );
    log(
      fmt(
        "V15 holdout (TRAIN-LEAK)",
        runWalkForward(holdout, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V15_RECENT),
      ),
    );
    log(
      `(V15's holdout score is biased — it was optimized including this period)\n`,
    );

    // Now do PROPER OOS: optimize on TRAIN only (excluding last 6mo), validate on HOLDOUT
    log(
      `========== R28 — Sim. annealing on TRAIN ONLY (proper OOS) ==========`,
    );

    // Use TRAIN's "last 1y" (= train-data's last 1y, which precedes the holdout)
    const trainN = Object.values(train)[0].length;
    const train1yBars = 365 * BARS_PER_DAY;
    const train1y: Record<string, Candle[]> = {};
    for (const s of SOURCES)
      train1y[s] = train[s].slice(-Math.min(train1yBars, trainN));

    let best = {
      cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
      train1y: 0,
      holdout: 0,
      tl: 0,
    };
    {
      const t = runWalkForward(train1y, best.cfg);
      const h = runWalkForward(holdout, best.cfg);
      best.train1y = t.passRate;
      best.holdout = h.passRate;
      best.tl = t.tlBreaches;
      log(
        `V8 baseline: train1y=${(t.passRate * 100).toFixed(2)}% TL=${t.tlBreaches}, holdout=${(h.passRate * 100).toFixed(2)}%`,
      );
    }

    for (let trial = 0; trial < 1500; trial++) {
      const cfg: FtmoDaytrade24hConfig = JSON.parse(JSON.stringify(best.cfg));
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
                  symbol: pickv(["ETHUSDT", "BTCUSDT", "BNBUSDT", "LINKUSDT"]),
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
        cfg.crossAssetFilter.emaSlowPeriod <= cfg.crossAssetFilter.emaFastPeriod
      )
        continue;
      if (
        cfg.trailingStop &&
        cfg.trailingStop.trailPct >= cfg.trailingStop.activatePct
      )
        continue;

      const t = runWalkForward(train1y, cfg);
      if (t.tlBreaches > 5) continue;
      if (t.passRate > best.train1y) {
        const h = runWalkForward(holdout, cfg);
        best = {
          cfg,
          train1y: t.passRate,
          holdout: h.passRate,
          tl: t.tlBreaches,
        };
        log(
          `  *** trial ${trial} TRAIN1y=${(t.passRate * 100).toFixed(2)}% → HOLDOUT=${(h.passRate * 100).toFixed(2)}% TL=${t.tlBreaches}`,
        );
      }
      if ((trial + 1) % 250 === 0) {
        log(
          `  ${trial + 1}/1500 — train1y best=${(best.train1y * 100).toFixed(2)}% holdout=${(best.holdout * 100).toFixed(2)}%`,
        );
      }
    }

    log(`\n========== R28 RESULT ==========`);
    log(`Train-1y best:  ${(best.train1y * 100).toFixed(2)}% (TL=${best.tl})`);
    log(`Holdout (TRUE OOS): ${(best.holdout * 100).toFixed(2)}%`);
    log(
      `Generalization gap: ${((best.holdout - best.train1y) * 100).toFixed(2)}pp`,
    );
    log(
      `\nFor live forecast: holdout pass-rate ${(best.holdout * 100).toFixed(2)}% is the honest expectation`,
    );

    expect(true).toBe(true);
  });
});
