/**
 * R22 — find Pareto-better V14: pass-rate ≥48% AND TL ≤ V12's 13
 *
 * Score function changed: STRONG TL penalty.
 * Random search 2000 trials with TL <= 18 hard floor.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R22_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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

// Score function: hard reject if TL > 18, then maximize pass-rate
function scorePareto(a: BatchResult, b: BatchResult, maxTL = 18) {
  const aOk = a.tlBreaches <= maxTL;
  const bOk = b.tlBreaches <= maxTL;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  // both OK or both not OK
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

describe("R23 — Pareto V14 search TL≤22", { timeout: 24 * 3600_000 }, () => {
  it("runs R22", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R22 START ${new Date().toISOString()}\n`);

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

    const v12R = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12);
    const v13R = runWalkForward(
      data,
      FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V13_RISKY,
    );
    log(fmt("V12 (target safety: TL≤13)", v12R));
    log(fmt("V13 RISKY (TL=31, ref)", v13R));

    let best = {
      cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
      r: v12R,
      label: "V12",
    };

    // 2000 random trials with TL hard cap = 18 (V12's 13 + 5 buffer)
    log(`\n--- 2000 random trials with TL ≤ 18 hard cap ---`);
    for (let trial = 0; trial < 2000; trial++) {
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 6 + Math.floor(Math.random() * 12);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V12,
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
      if (scorePareto(r, best.r, 18) < 0) {
        best = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if ((trial + 1) % 400 === 0) {
        log(
          `  ${trial + 1}/2000 — best: ${(best.r.passRate * 100).toFixed(2)}% TL=${best.r.tlBreaches}`,
        );
      }
    }

    log(`\n========== R22 FINAL ==========`);
    log(fmt("V12 baseline (safe)", v12R));
    log(fmt("V13 RISKY", v13R));
    log(fmt("R22 V14 candidate", best.r));
    log(
      `\nΔ V12 → V14: +${((best.r.passRate - v12R.passRate) * 100).toFixed(2)}pp (TL constraint ≤ 18)`,
    );

    if (scorePareto(best.r, v12R, 18) < 0) {
      writeFileSync(
        `${LOG_DIR}/R22_FINAL_CONFIG.json`,
        JSON.stringify(best.cfg, null, 2),
      );
    }

    expect(best.r.passRate).toBeGreaterThanOrEqual(v12R.passRate);
  });
});
