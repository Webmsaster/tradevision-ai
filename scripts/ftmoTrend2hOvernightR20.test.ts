/**
 * R20 — push V11 with per-asset stopPct + new ideas
 *
 * 20A: per-asset stopPct sweep on V11
 * 20B: per-asset triggerBars on V11
 * 20C: per-asset holdBars on V11
 * 20D: choppinessFilter wider grid on V11
 * 20E: HTF threshold sweep
 * 20F: 1000 random trials with V11 base
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R20_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

describe("R20 — push V11", { timeout: 24 * 3600_000 }, () => {
  it("runs R20", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R20 START ${new Date().toISOString()}\n`);

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
      JSON.stringify(FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V11),
    ) as FtmoDaytrade24hConfig;
    const baseR = runWalkForward(data, cur);
    log(fmt("R20 BASELINE V11", baseR));

    // 20A: per-asset stopPct
    log(`\n--- 20A: per-asset stopPct ---`);
    let aBest = { cfg: cur, r: baseR };
    for (const a of aBest.cfg.assets) {
      let aBest2 = { cfg: aBest.cfg, r: aBest.r, sp: a.stopPct };
      for (const sp of [0.03, 0.035, 0.04, 0.045, 0.05]) {
        const trial = {
          ...aBest.cfg,
          assets: aBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, stopPct: sp } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest2.r) < 0) aBest2 = { cfg: trial, r, sp };
      }
      if (score(aBest2.r, aBest.r) < 0) {
        aBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} sp=${aBest2.sp}`, aBest2.r));
      }
    }
    log(fmt(`20A WINNER`, aBest.r));
    cur = aBest.cfg;

    // 20B: per-asset triggerBars
    log(`\n--- 20B: per-asset triggerBars ---`);
    let bBest = { cfg: cur, r: aBest.r };
    for (const a of bBest.cfg.assets) {
      let aBest2 = { cfg: bBest.cfg, r: bBest.r, tb: a.triggerBars };
      for (const tb of [1, 2, 3]) {
        const trial = {
          ...bBest.cfg,
          assets: bBest.cfg.assets.map((x) =>
            x.symbol === a.symbol ? { ...x, triggerBars: tb } : x,
          ),
        };
        const r = runWalkForward(data, trial);
        if (score(r, aBest2.r) < 0) aBest2 = { cfg: trial, r, tb };
      }
      if (score(aBest2.r, bBest.r) < 0) {
        bBest = { cfg: aBest2.cfg, r: aBest2.r };
        log(fmt(`  ${a.symbol} tb=${aBest2.tb}`, aBest2.r));
      }
    }
    log(fmt(`20B WINNER`, bBest.r));
    cur = bBest.cfg;

    // 20C: per-asset holdBars
    log(`\n--- 20C: per-asset holdBars ---`);
    let cBest = { cfg: cur, r: bBest.r };
    for (const a of cBest.cfg.assets) {
      let aBest2 = { cfg: cBest.cfg, r: cBest.r, hb: a.holdBars };
      for (const hb of [120, 180, 240, 360, 480]) {
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
    log(fmt(`20C WINNER`, cBest.r));
    cur = cBest.cfg;

    // 20D: choppiness wider
    log(`\n--- 20D: choppiness wider ---`);
    let dBest = { cfg: cur, r: cBest.r, label: "current" };
    for (const period of [6, 10, 14, 20, 28]) {
      for (const maxCi of [55, 60, 65, 68, 70, 72, 75, 78, 82]) {
        for (const minCi of [undefined, 30, 35, 40]) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            choppinessFilter: {
              period,
              maxCi,
              ...(minCi !== undefined ? { minCi } : {}),
            },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, dBest.r) < 0) {
            dBest = {
              cfg,
              r,
              label: `chop p=${period} max=${maxCi} min=${minCi ?? "-"}`,
            };
            log(fmt(`  ${dBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`20D WINNER (${dBest.label})`, dBest.r));
    cur = dBest.cfg;

    // 20E: HTF deeper
    log(`\n--- 20E: HTF deeper ---`);
    let eBest = { cfg: cur, r: dBest.r, label: "current" };
    for (const lb of [12, 24, 36, 48, 72, 96, 120, 168, 240]) {
      for (const thr of [
        -0.05, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.05, 0.08,
      ]) {
        for (const apply of ["long", "both"] as const) {
          const cfg: FtmoDaytrade24hConfig = {
            ...cur,
            htfTrendFilter: { lookbackBars: lb, apply, threshold: thr },
          };
          const r = runWalkForward(data, cfg);
          if (score(r, eBest.r) < 0) {
            eBest = { cfg, r, label: `htf ${apply} lb=${lb} thr=${thr}` };
            log(fmt(`  ${eBest.label}`, r));
          }
        }
      }
    }
    log(fmt(`20E WINNER (${eBest.label})`, eBest.r));
    cur = eBest.cfg;

    // 20F: 1000 random trials with V11 base
    log(`\n--- 20F: 1000 random trials ---`);
    let fBest = { cfg: cur, r: eBest.r, label: "current" };
    for (let trial = 0; trial < 1000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 10);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...cur, // start from current best
        allowedHoursUtc: hours,
        adxFilter: { period: pickv([10, 14, 20]), minAdx: pickv([0, 5, 10]) },
        htfTrendFilter: maybe(0.7, () => ({
          lookbackBars: pickv([24, 48, 72, 120]),
          apply: pickv(["long", "both"] as const),
          threshold: pickv([-0.05, 0, 0.02, 0.05]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pickv([28, 56, 84]),
          mult: pickv([2, 2.5, 3, 4]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.6, () => ({
          period: pickv([10, 14, 20]),
          maxCi: pickv([60, 65, 70, 75, 78]),
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
            emaFastPeriod: pickv([4, 8]),
            emaSlowPeriod: pickv([24, 48, 96]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
        volumeFilter: maybe(0.7, () => ({
          period: pickv([20, 30, 50, 75, 100]),
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
      if (score(r, fBest.r) < 0) {
        fBest = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 200 === 0) {
        log(
          `  ${trial + 1}/1000 — best: ${(fBest.r.passRate * 100).toFixed(2)}% TL=${fBest.r.tlBreaches}`,
        );
      }
    }
    log(fmt(`20F WINNER (${fBest.label})`, fBest.r));
    cur = fBest.cfg;

    log(`\n========== R20 FINAL ==========`);
    log(fmt("R20 baseline V11", baseR));
    log(fmt("After 20A (per-sp)", aBest.r));
    log(fmt("After 20B (per-tb)", bBest.r));
    log(fmt("After 20C (per-hb)", cBest.r));
    log(fmt("After 20D (chop)", dBest.r));
    log(fmt("After 20E (htf)", eBest.r));
    log(fmt("After 20F (random)", fBest.r));
    log(
      `\nΔ V11 → R20: +${((fBest.r.passRate - baseR.passRate) * 100).toFixed(2)}pp`,
    );

    if (score(fBest.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R20_FINAL_CONFIG.json`,
        JSON.stringify(cur, null, 2),
      );
    }

    expect(fBest.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
