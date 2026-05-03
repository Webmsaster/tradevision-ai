/**
 * R12 — random search to escape 46.20% plateau
 *
 * 200 random configs sampling joint param-space:
 *   - ADX (period × minAdx)
 *   - HTF (lb × thr × apply)
 *   - chand (period × mult)
 *   - chop (period × maxCi)
 *   - LSC (after × cd)
 *   - BTC CAF (fast × slow × mb × ml × skipDown)
 *   - trailing (act × tr)
 *   - hours (random subset)
 *   - tp/sp universal
 *   - timeBoost
 *
 * Log every config that beats 46.20%.
 */
import { describe, it, expect } from "vitest";
import {
  runFtmoDaytrade24h,
  type FtmoDaytrade24hConfig,
  type FtmoDaytrade24hResult,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
  FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V5,
} from "../src/utils/ftmoDaytrade24h";
import { loadBinanceHistory } from "../src/utils/historicalData";
import type { Candle } from "../src/utils/indicators";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { shuffled as fyShuffle } from "./_passDayUtils";

const BARS_PER_DAY = 12;
const LOG_DIR = "scripts/overnight_results";
const LOG_FILE = `${LOG_DIR}/R12_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

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
  return `${label.padEnd(50)} ${r.passes.toString().padStart(4)}/${String(r.windows).padStart(4)} = ${(r.passRate * 100).toFixed(2).padStart(6)}%  med=${r.medianDays}d p75=${r.p75Days} p90=${r.p90Days}  TL=${r.tlBreaches} DL=${r.dlBreaches}  EV=$${r.ev.toFixed(0)}`;
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

describe("R12 — random search 200 cfgs", { timeout: 24 * 3600_000 }, () => {
  it("runs R12", async () => {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_FILE, `R12 START ${new Date().toISOString()}\n`);

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

    const baseR = runWalkForward(data, FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8);
    log(fmt("V8 BASELINE (target to beat)", baseR));

    let best = {
      cfg: FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
      r: baseR,
      label: "V8",
    };
    let evaluated = 0;

    // Random search — 250 trials
    for (let trial = 0; trial < 250; trial++) {
      // Random subset of hours (8-14 hours)
      const allHours = Array.from({ length: 24 }, (_, i) => i);
      const targetCount = 8 + Math.floor(Math.random() * 7);
      const hours = fyShuffle(allHours)
        .slice(0, targetCount)
        .sort((a, b) => a - b);

      const cfg: FtmoDaytrade24hConfig = {
        ...FTMO_DAYTRADE_24H_CONFIG_TREND_2H_V8,
        allowedHoursUtc: hours,
        adxFilter: maybe(0.85, () => ({
          period: pick([8, 10, 14, 20]),
          minAdx: pick([8, 10, 12, 15, 18]),
        })),
        htfTrendFilter: maybe(0.6, () => ({
          lookbackBars: pick([24, 48, 72, 120]),
          apply: pick(["long", "both"] as const),
          threshold: pick([-0.02, 0, 0.01, 0.05]),
        })),
        chandelierExit: maybe(0.5, () => ({
          period: pick([28, 56, 84, 168]),
          mult: pick([2, 2.5, 3, 4]),
          minMoveR: 0.5,
        })),
        choppinessFilter: maybe(0.5, () => ({
          period: pick([10, 14, 20]),
          maxCi: pick([60, 65, 70, 75, 78]),
        })),
        lossStreakCooldown: maybe(0.7, () => ({
          afterLosses: pick([2, 3, 4]),
          cooldownBars: pick([24, 48, 72, 120]),
        })),
        crossAssetFilter: {
          symbol: "BTCUSDT",
          emaFastPeriod: pick([4, 6, 8, 12]),
          emaSlowPeriod: pick([12, 24, 36, 48]),
          skipLongsIfSecondaryDowntrend: Math.random() < 0.3,
          momentumBars: pick([12, 18, 24, 36, 48]),
          momSkipLongBelow: pick([-0.05, -0.03, -0.02, -0.01, 0]),
        },
        trailingStop: {
          activatePct: pick([0.02, 0.025, 0.03, 0.04]),
          trailPct: pick([0.003, 0.005, 0.008, 0.012]),
        },
        timeBoost: maybe(0.4, () => ({
          afterDay: pick([4, 6, 8, 12]),
          equityBelow: pick([0.02, 0.05, 0.08]),
          factor: pick([1.5, 2, 2.5]),
        })),
        crossAssetFiltersExtra: maybe(0.5, () => [
          {
            symbol: "ETHUSDT",
            emaFastPeriod: pick([4, 8, 12]),
            emaSlowPeriod: pick([12, 24, 48]),
            skipLongsIfSecondaryDowntrend: true,
          },
        ]),
      };
      const r = runWalkForward(data, cfg);
      evaluated++;
      if (score(r, best.r) < 0) {
        best = { cfg, r, label: `trial ${trial}` };
        log(fmt(`  *** trial ${trial} BEST`, r));
      }
      if (evaluated % 25 === 0) {
        log(
          `  ${evaluated} trials done — best so far: ${(best.r.passRate * 100).toFixed(2)}% TL=${best.r.tlBreaches}`,
        );
      }
    }

    log(`\n========== R12 FINAL ==========`);
    log(fmt("V8 baseline", baseR));
    log(fmt("Random search BEST", best.r));
    log(
      `\nΔ V8 → R12: +${((best.r.passRate - baseR.passRate) * 100).toFixed(2)}pp (after ${evaluated} trials)`,
    );

    if (score(best.r, baseR) < 0) {
      writeFileSync(
        `${LOG_DIR}/R12_FINAL_CONFIG.json`,
        JSON.stringify(best.cfg, null, 2),
      );
      log(`Wrote R12_FINAL_CONFIG.json`);
    } else {
      log(`No improvement — V8 stays champion`);
    }

    expect(best.r.passRate).toBeGreaterThanOrEqual(baseR.passRate);
  });
});
