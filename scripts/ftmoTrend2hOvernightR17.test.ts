/**
 * R17 — push V9 (with volume filter) further
 *
 * 17A: volumeFilter fine-grain (smaller increments)
 * 17B: V9 + re-tune ADX/HTF/CAF jointly
 * 17C: 500 more random trials starting from V9
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R17_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R17 — push V9", { timeout: 24 * 3600_000 }, () => {
  it("runs R17", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R17 START ${new Date().toISOString()}\n`);

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
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9),
    ) as FtmoDaytrade24hConfig;
    const baseR = runWalkForward(data, cur);
    log(fmt("R17 BASELINE V9", baseR));

    // 17A: volumeFilter fine-grain
    log(`\n--- 17A: volumeFilter fine-grain ---`);
    let aBest = { cfg: cur, r: baseR, label: "current 50/0.5" };
    for (const period of [20, 30, 40, 50, 75, 100, 150, 200]) {
      for (const minRatio of [
        0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2,
      ]) {
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
    log(fmt(`17A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // 17B: re-tune ADX with vol filter active
    log(`\n--- 17B: ADX re-tune w/ vol ---`);
    let bBest = { cfg: cur, r: aBest.r, label: "current" };
    for (const period of [6, 8, 10, 14, 20, 28]) {
      for (const minAdx of [5, 8, 10, 12, 15, 18, 20]) {
        const cfg: FtmoDaytrade24hConfig = {
          ...cur,
          adxFilter: { period, minAdx },
        };
        const r = runWalkForward(data, cfg);
        if (score(r, bBest.r) < 0) {
          bBest = { cfg, r, label: `adx p=${period} m=${minAdx}` };
          log(fmt(`  ${bBest.label}`, r));
        }
      }
    }
    log(fmt(`17B WINNER (${bBest.label})`, bBest.r));
    cur = bBest.cfg;

    // 17C: 500 random with V9 base
    log(`\n--- 17C: 500 random trials from V9 ---`);
    let cBest = { cfg: cur, r: bBest.r, label: "current" };
    for (let trial = 0; trial < 500; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 10);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V9,
        allowedHoursUtc: hours,
        adxFilter: {
          period: pick([6, 8, 10, 14, 20]),
          minAdx: pick([8, 10, 12, 15, 18]),
        },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pick([24, 48, 72, 120, 240]),
          apply: pick(["long", "both"] as const),
          threshold: pick([-0.05, -0.02, 0, 0.02, 0.05]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pick([28, 56, 84, 168]),
          mult: pick([2, 2.5, 3, 4]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.6, () => ({
          period: pick([10, 14, 20]),
          maxCi: pick([60, 65, 70, 75, 78]),
        })),
        lossStreakCooldown: maybe(0.7, () => ({
          afterLosses: pick([2, 3, 4]),
          cooldownBars: pick([24, 48, 72, 120]),
        })),
        crossAssetFilter: {
          symbol: "BTCUSDT",
          emaFastPeriod: pick([2, 4, 6, 8, 12]),
          emaSlowPeriod: pick([12, 16, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pick([12, 18, 24, 36, 48]),
          momSkipLongBelow: pick([-0.05, -0.03, -0.02, -0.01, 0]),
        },
        crossAssetFiltersExtra: maybe(0.5, () => [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: pick([4, 8, 12]),
            emaSlowPeriod: pick([12, 24, 48]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: {
          period: pick([20, 30, 50, 75, 100]),
          minRatio: pick([0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
        },
        trailingStop: {
          activatePct: pick([0.02, 0.025, 0.03, 0.04]),
          trailPct: pick([0.003, 0.005, 0.008, 0.012]),
        },
      };
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
      if (score(r, cBest.r) < 0) {
        cBest = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 100 === 0) {
        log(
          `  ${trial + 1}/500 — best: ${(cBest.r.passRate * 100).toFixed(2)}% TL=${cBest.r.tlBreaches}`,
        );
      }
    }
    log(fmt(`17C WINNER (${cBest.label})`, cBest.r));
    cur = cBest.cfg;

    log(`\n========== R17 FINAL ==========`);
    log(fmt("R17 baseline V9", baseR));
    log(fmt("After 17A (vol fine)", aBest.r));
    log(fmt("After 17B (ADX retune)", bBest.r));
    log(fmt("After 17C (500 random)", cBest.r));
    log(
      `\nΔ V9 → R17: +${((cBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    if (score(cBest.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R17_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );
    }

    expect(cBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
