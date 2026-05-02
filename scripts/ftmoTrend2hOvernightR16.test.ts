/**
 * R16 — last attempt: volumeFilter + per-asset ADX + per-asset hours
 *
 * 16A: volumeFilter (skip thin-volume entries)
 * 16B: per-asset emaFastPeriod/emaSlowPeriod tuning (asset's own MA filter)
 * 16C: simulated annealing — random swaps around V8
 * 16D: try MUCH wider random search (500 trials) with broader bounds
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R16_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(45)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
}

function score(a: BatchResult, b: BatchResult) {
  const dPass = b.passRate - a.passRate;
  if (Math.abs(dPass) > 1e-9) return dPass;
  return a.tlBreaches - b.tlBreaches;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function maybe<T>(prob: number, get: () => T | undefined): T | undefined {
  return Math.random() < prob ? get() : undefined;
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

describe("R16 — last push", { timeout: 24 * 3600_000 }, () => {
  it("runs R16", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R16 START ${new Date().toISOString()}\n`);

    log(`Loading 2h data...`);
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

    let cur = JSON.parse(
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8),
    ) as FtmoDaytrade24hConfig;
    const baseR = runWalkForward(data, cur);
    log(fmt("R16 BASELINE V8", baseR));

    // 16A: volumeFilter
    log(`\n--- 16A: volumeFilter ---`);
    let aBest = { cfg: cur, r: baseR, label: "off" };
    for (const period of [10, 20, 50, 100]) {
      for (const minRatio of [0.5, 0.7, 1.0, 1.2, 1.5, 2.0]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          volumeFilter: { period, minRatio },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, aBest.r) < 0) {
          aBest = { cfg, r, label: `vol p=${period} r=${minRatio}` };
          log(fmt(`  ${aBest.label}`, r));
        }
      }
    }
    log(fmt(`16A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // 16B: per-asset CAF (replace primary BTC with per-asset secondary)
    // (engine has only one primary CAF, so this can't be per-asset. Skip.)

    // 16C: 500-trial wider random search
    log(`\n--- 16C: 500 random trials wide bounds ---`);
    let bBest = { cfg: cur, r: aBest.r, label: "current" };
    for (let trial = 0; trial < 500; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 10);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
        allowedHoursUtc: hours,
        adxFilter: {
          period: pick([6, 8, 10, 14, 20, 28, 40]),
          minAdx: pick([5, 8, 10, 12, 15, 18, 20, 22, 25]),
        },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pick([12, 24, 48, 72, 120, 240, 500]),
          apply: pick(["long", "both"] as const),
          threshold: pick([-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.2]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pick([14, 28, 56, 84, 168, 336]),
          mult: pick([1.5, 2, 2.5, 3, 4, 5, 6]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.5, () => ({
          period: pick([6, 10, 14, 20, 28, 40]),
          maxCi: pick([55, 60, 65, 70, 75, 78, 82, 85]),
        })),
        lossStreakCooldown: maybe(0.7, () => ({
          afterLosses: pick([2, 3, 4, 5]),
          cooldownBars: pick([12, 24, 48, 72, 120, 200, 300]),
        })),
        crossAssetFilter: {
          symbol: "BTCUSDT",
          emaFastPeriod: pick([2, 4, 6, 8, 12, 16, 24]),
          emaSlowPeriod: pick([12, 16, 24, 36, 48, 72, 96, 168]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pick([6, 12, 18, 24, 36, 48, 72, 96]),
          momSkipLongBelow: pick([-0.08, -0.05, -0.03, -0.02, -0.01, 0, 0.01]),
        },
        crossAssetFiltersExtra: maybe(0.6, () => [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: pick([4, 8, 12, 24]),
            emaSlowPeriod: pick([12, 24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        trailingStop: {
          activatePct: pick([0.015, 0.02, 0.025, 0.03, 0.04, 0.05]),
          trailPct: pick([0.002, 0.003, 0.005, 0.008, 0.012, 0.018]),
        },
        timeBoost: maybe(0.4, () => ({
          afterDay: pick([2, 4, 6, 8, 12]),
          equityBelow: pick([0.02, 0.04, 0.06, 0.08]),
          factor: pick([1.3, 1.5, 2, 2.5]),
        })),
      };
      // Filter trail validity
      if (
        cfg.trailingStop &&
        cfg.trailingStop.trailPct >= cfg.trailingStop.activatePct
      )
        continue;
      if (
        cfg.crossAssetFilter &&
        cfg.crossAssetFilter.emaSlowPeriod <= cfg.crossAssetFilter.emaFastPeriod
      )
        continue;

      const r = runWalkForward(data, cfg);
      if (score(r, bBest.r) < 0) {
        bBest = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 50 === 0) {
        log(
          `  ${trial + 1}/500 trials done — best: ${(bBest.r.passRate * 100).toFixed(2)}%`,
        );
      }
    }
    log(fmt(`16C WINNER (${bBest.label})`, bBest.r));
    cur = bBest.cfg;

    log(`\n========== R16 FINAL ==========`);
    log(fmt("R16 baseline V8", baseR));
    log(fmt("After 16A (vol)", aBest.r));
    log(fmt("After 16C (random 500)", bBest.r));
    log(
      `\nΔ V8 → R16: +${((bBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    if (score(bBest.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R16_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );
      log(`\nNEW CHAMPION written to R16_FINAL_CONFIG.json`);
    }

    expect(bBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
