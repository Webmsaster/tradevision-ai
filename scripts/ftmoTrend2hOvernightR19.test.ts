/**
 * R19 — push V10 with new ideas
 *
 * 19A: vol filter combined with adxFilter maxAdx (skip exhausted trends)
 * 19B: per-asset stopPct/tpPct sweep on V10
 * 19C: 1000-trial random with V10 base + new dim: maxAdx, volatilityFilter
 * 19D: try MUCH MORE assets: top-15 by liquidity
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type Daytrade24hAssetCfg,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R19_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R19 — push V10 + new dims", { timeout: 24 * 3600_000 }, () => {
  it("runs R19", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R19 START ${new Date().toISOString()}\n`);

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
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10),
    ) as FtmoDaytrade24hConfig;
    const baseR = runWalkForward(data, cur);
    log(fmt("R19 BASELINE V10", baseR));

    // 19A: ADX maxAdx (skip exhausted trends)
    log(`\n--- 19A: ADX maxAdx ---`);
    let aBest = { cfg: cur, r: baseR, label: "current" };
    for (const maxAdx of [25, 30, 40, 50, 60, 80]) {
      const cfg: FtmoDaytrade24hConfig = {
        ...cur,
        adxFilter: { ...(cur.adxFilter as any), maxAdx },
      };
      const r = runWalkForward(data, cfg);
      if (score(r, aBest.r) < 0) {
        aBest = { cfg, r, label: `maxAdx=${maxAdx}` };
        log(fmt(`  ${aBest.label}`, r));
      }
    }
    log(fmt(`19A WINNER (${aBest.label})`, aBest.r));
    cur = aBest.cfg;

    // 19B: per-asset sp/tp on V10
    log(`\n--- 19B: per-asset sp/tp ---`);
    let bBest = { cfg: cur, r: aBest.r };
    // Try each asset's sp
    for (const a of bBest.cfg.assets) {
      let aBest2 = { cfg: bBest.cfg, r: bBest.r, sp: a.stopPct, tp: a.tpPct };
      for (const sp of [0.03, 0.04, 0.045, 0.05]) {
        for (const tp of [0.05, 0.06, 0.07, 0.08, 0.1]) {
          if (tp <= sp) continue;
          const trial = {
            ...bBest.cfg,
            assets: bBest.cfg.assets.map((x) =>
              x.symbol === a.symbol ? { ...x, stopPct: sp, tpPct: tp } : x,
            ),
          };
          const r = runWalkForward(data, trial);
          if (score(r, aBest2.r) < 0) {
            aBest2 = { cfg: trial, r, sp, tp };
          }
        }
      }
      if (score(aBest2.r, bBest.r) < 0) {
        bBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} sp=${aBest2.sp} tp=${aBest2.tp}`, aBest2.r));
      }
    }
    log(fmt(`19B WINNER`, bBest.r));
    cur = bBest.cfg;

    // 19C: 1000 random trials with new dims
    log(`\n--- 19C: 1000 random trials ---`);
    let cBest = { cfg: cur, r: bBest.r, label: "current" };
    for (let trial = 0; trial < 1000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 10);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V10,
        allowedHoursUtc: hours,
        adxFilter: {
          period: pick([10, 14, 20]),
          minAdx: pick([0, 5, 10, 15]),
          maxAdx: maybe(0.5, () => pick([30, 40, 50, 70])),
        },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pick([24, 48, 72, 120]),
          apply: pick(["long", "both"] as const),
          threshold: pick([-0.05, 0, 0.02, 0.05]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pick([28, 56, 84]),
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
          symbol: pick(["BTCUSDT", "ETHUSDT"]),
          emaFastPeriod: pick([4, 6, 8, 12]),
          emaSlowPeriod: pick([12, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pick([12, 18, 24, 36, 48]),
          momSkipLongBelow: pick([-0.05, -0.03, -0.02, -0.01, 0]),
        },
        crossAssetFiltersExtra: maybe(0.5, () => [
          {
            symbol: pick(["ETHUSDT", "BTCUSDT", "BNBUSDT"]),
            emaFastPeriod: pick([4, 8]),
            emaSlowPeriod: pick([24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: maybe(0.7, () => ({
          period: pick([20, 30, 50, 75, 100]),
          minRatio: pick([0.3, 0.4, 0.5, 0.6, 0.7]),
        })),
        trailingStop: {
          activatePct: pick([0.02, 0.025, 0.03, 0.04]),
          trailPct: pick([0.001, 0.002, 0.003, 0.005]),
        },
        // Asset filter validation needed
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
      if (score(r, cBest.r) < 0) {
        cBest = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 200 === 0) {
        log(
          `  ${trial + 1}/1000 — best: ${(cBest.r.passRate * 100).toFixed(2)}% TL=${cBest.r.tlBreaches}`,
        );
      }
    }
    log(fmt(`19C WINNER (${cBest.label})`, cBest.r));
    cur = cBest.cfg;

    log(`\n========== R19 FINAL ==========`);
    log(fmt("R19 baseline V10", baseR));
    log(fmt("After 19A (maxAdx)", aBest.r));
    log(fmt("After 19B (per-asset sp/tp)", bBest.r));
    log(fmt("After 19C (1000 random)", cBest.r));
    log(
      `\nΔ V10 → R19: +${((cBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    if (score(cBest.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R19_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );
    }

    expect(cBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
