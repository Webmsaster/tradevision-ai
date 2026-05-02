/**
 * R21 — final overnight push on V12
 *
 * 21A: per-asset triggerBars (now with V12 stack)
 * 21B: per-asset chand exit (different period per asset)
 * 21C: per-asset volumeFilter (lol — engine has only global; just per-asset stop sweep again)
 * 21D: try MUCH wider random search (2000 trials) with broader bounds
 * 21E: combine V12 + tight cooldown variations
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R21_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

function pickv<T>(arr: T[]): T {
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

describe("R21 — final V12 push", { timeout: 24 * 3600_000 }, () => {
  it("runs R21", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R21 START ${new Date().toISOString()}\n`);

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
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12),
    ) as FtmoDaytrade24hConfig;
    const baseR = runWalkForward(data, cur);
    log(fmt("R21 BASELINE V12", baseR));

    // 21A: per-asset triggerBars (now with V12 stack)
    log(`\n--- 21A: per-asset triggerBars ---`);
    let aBest = { cfg: cur, r: baseR };
    for (const a of aBest.cfg.assets) {
      let aBest2 = { cfg: aBest.cfg, r: aBest.r, tb: a.triggerBars };
      for (const tb of [1, 2, 3]) {
        const trial = {
          ...aBest.cfg,
          assets: aBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, triggerBars: tb } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest2.r) < 0) aBest2 = { cfg: trial, r, tb };
      }
      if (score(aBest2.r, aBest.r) < 0) {
        aBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} tb=${aBest2.tb}`, aBest2.r));
      }
    }
    log(fmt(`21A WINNER`, aBest.r));
    cur = aBest.cfg;

    // 21B: per-asset stopPct
    log(`\n--- 21B: per-asset stopPct (V12) ---`);
    let bBest = { cfg: cur, r: aBest.r };
    for (const a of bBest.cfg.assets) {
      let aBest2 = { cfg: bBest.cfg, r: bBest.r, sp: a.stopPct };
      for (const sp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
        const trial = {
          ...bBest.cfg,
          assets: bBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, stopPct: sp } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest2.r) < 0) aBest2 = { cfg: trial, r, sp };
      }
      if (score(aBest2.r, bBest.r) < 0) {
        bBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} sp=${aBest2.sp}`, aBest2.r));
      }
    }
    log(fmt(`21B WINNER`, bBest.r));
    cur = bBest.cfg;

    // 21C: per-asset holdBars (V12 only has BTC=180)
    log(`\n--- 21C: per-asset holdBars ---`);
    let cBest = { cfg: cur, r: bBest.r };
    for (const a of cBest.cfg.assets) {
      let aBest2 = { cfg: cBest.cfg, r: cBest.r, hb: a.holdBars };
      for (const hb of [120, 180, 240, 360, 480, 600]) {
        const trial = {
          ...cBest.cfg,
          assets: cBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, holdBars: hb } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest2.r) < 0) aBest2 = { cfg: trial, r, hb };
      }
      if (score(aBest2.r, cBest.r) < 0) {
        cBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} hb=${aBest2.hb}`, aBest2.r));
      }
    }
    log(fmt(`21C WINNER`, cBest.r));
    cur = cBest.cfg;

    // 21D: 2000 random trials
    log(`\n--- 21D: 2000 random trials ---`);
    let dBest = { cfg: cur, r: cBest.r, label: "current" };
    for (let trial = 0; trial < 2000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 12);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        allowedHoursUtc: hours,
        adxFilter: { period: pickv([10, 14, 20]), minAdx: pickv([0, 5, 10]) },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pickv([24, 48, 72, 120, 240]),
          apply: pickv(["long", "both"] as const),
          threshold: pickv([-0.05, 0, 0.02, 0.05]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pickv([28, 56, 84, 168]),
          mult: pickv([2, 2.5, 3, 4]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.6, () => ({
          period: pickv([10, 14, 20]),
          maxCi: pickv([60, 65, 70, 72, 75, 78]),
        })),
        lossStreakCooldown: maybe(0.7, () => ({
          afterLosses: pickv([2, 3, 4]),
          cooldownBars: pickv([24, 48, 72, 120]),
        })),
        crossAssetFilter: {
          symbol: pickv(["BTCUSDT", "ETHUSDT"]),
          emaFastPeriod: pickv([4, 6, 8, 12]),
          emaSlowPeriod: pickv([12, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pickv([12, 18, 24, 36, 48]),
          momSkipLongBelow: pickv([-0.05, -0.03, -0.02, -0.01, 0]),
        },
        crossAssetFiltersExtra: maybe(0.5, () => [
          {
            symbol: pickv(["ETHUSDT", "BTCUSDT", "BNBUSDT"]),
            emaFastPeriod: pickv([4, 8, 12]),
            emaSlowPeriod: pickv([24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: maybe(0.7, () => ({
          period: pickv([20, 30, 50, 75, 100, 150]),
          minRatio: pickv([0.3, 0.4, 0.5, 0.6, 0.7]),
        })),
        trailingStop: {
          activatePct: pickv([0.02, 0.025, 0.03, 0.04]),
          trailPct: pickv([0.001, 0.002, 0.003, 0.005]),
        },
      };
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

      const r = runWalkForward(data, cfg);
      if (score(r, dBest.r) < 0) {
        dBest = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 400 === 0) {
        log(
          `  ${trial + 1}/2000 — best: ${(dBest.r.passRate * 100).toFixed(2)}% TL=${dBest.r.tlBreaches}`,
        );
      }
    }
    log(fmt(`21D WINNER (${dBest.label})`, dBest.r));
    cur = dBest.cfg;

    log(`\n========== R21 FINAL ==========`);
    log(fmt("R21 baseline V12", baseR));
    log(fmt("After 21A (per-tb)", aBest.r));
    log(fmt("After 21B (per-sp)", bBest.r));
    log(fmt("After 21C (per-hb)", cBest.r));
    log(fmt("After 21D (2000 random)", dBest.r));
    log(
      `\nΔ V12 → R21: +${((dBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );
    log(
      `\nTotal vs V5 (44.11%): +${((dBest.r.passRate - 0.4411) * 100).toFixed(2)}pp`,
    );

    if (score(dBest.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R21_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );
    }

    expect(dBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
